import * as assert from 'node:assert/strict';
import { createServer, ServerResponse } from 'node:http';
import type { DraftProgress } from '../modules/composer/draftPreview';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Composition } from '../modules/composer/Composition';
import { ComposerGit } from '../modules/composer/git';
import { applyPlan } from '../modules/composer/apply';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { AdaptorFactory } from '../modules/adaptor/AdaptorFactory';
import { AnthropicAdaptor } from '../modules/adaptor/AnthropicAdaptor';
import { OpenAIAdaptor } from '../modules/adaptor/OpenAIAdaptor';
import { MessageRole } from '../modules/adaptor/unified-protocols/request';
import { Venders } from '../modules/configuration/configuration.constants';
import { CommitGenerator } from '../modules/git/CommitGenerator';
import { GitService } from '../modules/git/GitService';
import { Repository } from '../modules/git/typings/git';

interface ModelUsage {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens: number; cache_write_tokens?: number };
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
}

function modelStream(res: ServerResponse, provider: Venders, model: string, usage: ModelUsage, reasoning = false) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    res.setTimeout(5000, () => res.destroy());
    const send = (type: string, fields: object) => {
        res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    };
    const textIndex = reasoning ? 1 : 0;
    if (provider === Venders.Anthropic) {
        send('message_start', { message: { id: 'msg', role: 'assistant', model, content: [], usage } });
        if (reasoning) {
            send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
            send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'placeholder' } });
            send('content_block_stop', { index: 0 });
        }
        send('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } });
    } else if (reasoning) {
        send('response.output_item.added', { item: { type: 'reasoning', summary: [] } });
        send('response.reasoning_text.delta', { delta: 'placeholder' });
    }
    let text = '';
    return {
        write(delta: string) {
            text += delta;
            if (provider === Venders.OpenAI) { send('response.output_text.delta', { delta }); }
            else { send('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: delta } }); }
        },
        finish() {
            if (provider === Venders.OpenAI) {
                send('response.completed', { response: { model, usage, output: [
                    { type: 'message', content: [{ type: 'output_text', text }] },
                ] } });
            } else {
                send('content_block_stop', { index: textIndex });
                send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } });
                send('message_stop', {});
            }
            res.end();
        },
    };
}

suite('Commit model calls', () => {
    const diff = 'diff --git a/settings.ts b/settings.ts\n-old\n+new';
    const subject = 'fix: correct timeout';
    let baseUrl: string;
    let replies: string[] = [];
    let streamReply: ((res: ServerResponse) => void) | undefined;
    let bufferedGateway = false;
    let usageOverride: ModelUsage | null | undefined;
    teardown(() => { replies = []; streamReply = undefined; bufferedGateway = false; usageOverride = undefined; });
    const requests: { path?: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
        }
        const body = JSON.parse(raw);
        requests.push({ path: req.url, body });
        if (body.stream && streamReply) { streamReply(res); return; }
        const reply = replies.shift() ?? subject;
        const provider = req.url === '/v1/messages' ? Venders.Anthropic : Venders.OpenAI;
        const usage = usageOverride === undefined ? { input_tokens: 2728, output_tokens: 17, ...(provider === Venders.Anthropic
            ? { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
            : { input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }) } : usageOverride;
        if (body.stream && !bufferedGateway && usage) {
            const stream = modelStream(res, provider, body.model, usage);
            stream.write(reply);
            stream.finish();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(req.url === '/v1/messages'
            ? { model: body.model, content: [{ type: 'text', text: reply }], usage }
            : { model: body.model, output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }], usage }));
    });

    suiteSetup(async () => {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        AdaptorFactory.register(Venders.OpenAI, OpenAIAdaptor);
        AdaptorFactory.register(Venders.Anthropic, AnthropicAdaptor);
    });
    suiteTeardown(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));

    function commitGenerator(model: string, provider: Venders, onWrite?: (message: string) => void) {
        const log: string[] = [];
        const repo = { rootUri: vscode.Uri.file('/test'), inputBox: { value: '' } } as Repository;
        const git = {
            getRepository: () => repo,
            hasStagedChanges: () => true,
            getStagedDiff: async () => diff,
            setCommitMessage(message: string) {
                GitService.prototype.setCommitMessage(message, repo);
                onWrite?.(message);
            },
        };
        const config = {
            getBaseURLandSecrets: async () => ({ provider, baseUrl, apiKey: 'test' }),
            getModel: (setting = 'model') => setting === 'model' ? model : 'split-test-model',
            getPrompt: () => 'Write a subject.',
            log: (line: string) => log.push(line),
        };
        return { generator: new CommitGenerator(git, config), repo, log };
    }

    async function generate(model: string, provider = Venders.OpenAI) {
        const { generator, repo, log } = commitGenerator(model, provider);
        requests.length = 0;
        await generator.run();
        assert.equal(repo.inputBox.value, subject, log.join('\n'));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].body.model, model);
        assert.equal(requests[0].body.stream, true);
        return { ...requests[0], log };
    }

    test('Sends the full diff with explicit caching and no breakpoints on supported models', async () => {
        for (const model of ['gpt-5.6', 'gpt-5.10', 'gpt-6', 'gpt-6.1-sol', 'openai/gpt-6.1-sol-2026-10-01']) {
            const { path, body } = await generate(model);
            assert.equal(path, '/responses');
            assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
            assert.deepEqual(body.input, [{ role: 'user', content: diff }]);
        }
    });

    test('Omits caching parameters for earlier and unrecognized models, and for Claude', async () => {
        for (const model of ['gpt-4o', 'gpt-5', 'gpt-5.5-pro', 'deployment-a', 'other/gpt-6']) {
            assert.ok(!('prompt_cache_options' in (await generate(model)).body), model);
        }
        const { path, body } = await generate('claude-sonnet-4-6', Venders.Anthropic);
        assert.equal(path, '/v1/messages');
        assert.equal(typeof body.system, 'string');
        assert.deepEqual(body.messages, [{ role: 'user', content: diff }]);
        assert.ok(!('cache_control' in body));
    });

    test('Logs the same four token fields for both providers and distinguishes zero from missing usage', async () => {
        usageOverride = { input_tokens: 100, output_tokens: 17, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } };
        const openAI = (await generate('gpt-6.1-sol')).log.map(line => JSON.parse(line));
        const counts = { uncachedInput: 50, cacheWrite: 20, cacheRead: 30, output: 17 };
        assert.deepEqual(openAI.find(event => event.event === 'model.usage').tokens, counts);
        assert.equal(openAI.at(-1).totalTokens, 117);

        usageOverride = { input_tokens: 50, output_tokens: 17, cache_read_input_tokens: 30, cache_creation_input_tokens: null,
            cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 } };
        const claude = (await generate('claude', Venders.Anthropic)).log.map(line => JSON.parse(line));
        assert.deepEqual(claude.find(event => event.event === 'model.usage').tokens, counts);
        assert.equal(claude.at(-1).totalTokens, 117);

        const { generator, log } = commitGenerator('compatible', Venders.OpenAI);
        usageOverride = { input_tokens: 100, output_tokens: 17, input_tokens_details: { cached_tokens: 0 } };
        await generator.run();
        usageOverride = null;
        await generator.run();
        const events = log.map(line => JSON.parse(line));
        const starts = events.filter(event => event.event === 'task.started');
        const summaries = events.filter(event => event.event === 'task.finished');
        const usages = events.filter(event => event.event === 'model.usage');
        assert.equal(new Set(starts.map(event => event.taskId)).size, 2);
        assert.deepEqual(summaries.map(event => event.taskId), starts.map(event => event.taskId));
        assert.deepEqual(usages.map(event => [event.taskId, event.call]), starts.map(event => [event.taskId, 1]));
        assert.deepEqual(usages[0].tokens, { uncachedInput: null, cacheWrite: null, cacheRead: 0, output: 17 });
        assert.equal(summaries[0].totalTokens, 117);
        assert.deepEqual(usages[1].tokens, { uncachedInput: null, cacheWrite: null, cacheRead: null, output: null });
        assert.equal(summaries[1].totalTokens, null);
        assert.equal(summaries[1].callsWithoutTotal, 1);
    });

    test('Includes provider-reported usage when a stream ends with an incomplete response', async () => {
        streamReply = res => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
            res.end('event: response.incomplete\ndata: ' + JSON.stringify({ type: 'response.incomplete', response: {
                usage: { input_tokens: 100, output_tokens: 17, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } },
            } }) + '\n\n');
        };
        const { generator, repo, log } = commitGenerator('model', Venders.OpenAI);
        repo.inputBox.value = 'existing message';
        await generator.run();
        const events = log.map(line => JSON.parse(line));
        assert.equal(repo.inputBox.value, 'existing message');
        assert.equal(events.find(event => event.event === 'model.usage').totalTokens, 117);
        assert.equal(events.at(-1).status, 'failed');
        assert.equal(events.at(-1).totalTokens, 117);
    });

    test('Places the reusable prefix breakpoint on the diff only for both provider protocols', async () => {
        const messages = [{ role: MessageRole.USER, content: [{ type: 'text' as const, text: diff, cacheBreakpoint: true }] },
            { role: MessageRole.USER, content: 'Group the edits' }];
        for (const provider of [Venders.OpenAI, Venders.Anthropic]) {
            await AdaptorFactory.create(provider, baseUrl, 'test').createMessage({ model: 'gpt-6.1-sol', messages, max_output_tokens: 32 });
            const payload = requests.at(-1)!.body;
            if (provider === Venders.OpenAI) {
                assert.deepEqual(payload.prompt_cache_options, { mode: 'explicit' });
                assert.deepEqual(payload.input, [{ role: 'user', content: [{ type: 'input_text', text: diff,
                    prompt_cache_breakpoint: { mode: 'explicit' } }] }, { role: 'user', content: 'Group the edits' }]);
            } else {
                assert.deepEqual(payload.messages, [{ role: 'user', content: [{ type: 'text', text: diff,
                    cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'Group the edits' }]);
            }
        }
    });

    test('Composes, verifies and refines a real Git snapshot while preserving a locked diff', async function () {
        this.timeout(60000);
        const root = await mkdtemp(join(tmpdir(), 'pilot-workflow-'));
        try {
            const git = new ComposerGit(root, 'git');
            await git.run(['init', '-q', '-b', 'main']);
            await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, types: [] } }));
            await writeFile(join(root, 'old.ts'), 'const oldProblem: string = 12;');
            await git.run(['add', '.']);
            await git.run(['-c', 'commit.gpgSign=false', '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
            const before = await git.headState();
            let splitModel = '', pickCount = 0;
            const composition = new Composition(git, {
                getModel: (setting = 'model') => setting === 'composer.model' ? splitModel : 'ordinary-message-model',
                setupModel: async setting => {
                    assert.equal(setting, 'composer.model');
                    if (++pickCount === 1) { return; } // Dismiss the first picker.
                    return splitModel = 'gpt-6.1-sol';
                },
                getPrompt: () => 'Write a subject.', log() {},
                getBaseURLandSecrets: async () => ({ provider: Venders.OpenAI, baseUrl, apiKey: 'test' }),
            });
            const signal = new AbortController().signal;
            const groups = (...items: [string, number][]) => JSON.stringify({ commits: items.map(([message, id]) => ({ message, edits: [id] })) });
            await writeFile(join(root, 'z.md'), 'Guide');
            requests.length = 0;
            assert.equal(composition.model, '');
            const manual = await composition.start('working', '', true, signal);
            assert.ok(manual);
            assert.equal(pickCount, 0);
            assert.equal(await composition.refine(manual, '', signal), undefined);
            assert.equal(requests.length, 0);
            assert.equal(composition.model, '');
            replies = [groups(['docs', 1])];
            bufferedGateway = true;
            const fallback: DraftProgress[] = [];
            const quick = await composition.start('working', '', false, signal, 'quick', event => fallback.push(event));
            assert.deepEqual(fallback.find(event => event.type === 'replace'), {
                type: 'replace', drafts: [{ id: '1', message: 'docs', paths: ['z.md'] }],
            });
            const groupingProgress = fallback.flatMap(event => event.type === 'status' && event.step === 'grouping' ? [event.text] : []);
            assert.deepEqual(groupingProgress, [
                vscode.l10n.t('Sending the grouping request and waiting for a response…'),
                vscode.l10n.t('This response arrives all at once. Waiting for the complete result…'),
            ]);
            assert.equal(requests.length, 1);
            assert.equal(quick?.session?.deep, false);
            assert.equal(requests[0].body.model, splitModel);
            assert.equal(JSON.stringify(requests[0].body).includes('prompt_cache_breakpoint'), false);

            bufferedGateway = false;
            await writeFile(join(root, 'caller.ts'), "export { shared } from './shared';");
            await writeFile(join(root, 'shared.ts'), 'export const shared = 1;');
            requests.length = 0;
            replies = [JSON.stringify({ drafts: [
                { purpose: 'Use helper', anchorEdit: 1, paths: ['caller.ts'], dependsOn: ['Extract helper'] },
                { purpose: 'Extract helper', anchorEdit: 2, paths: ['shared.ts'], dependsOn: [] },
                { purpose: 'Document setup', anchorEdit: 3, paths: ['z.md'], dependsOn: [] },
            ] }),
                groups(['caller', 1], ['helper', 2], ['docs', 3]), JSON.stringify({ order: [1, 2, 3] })];
            const deep = await composition.start('working', 'Keep docs separate', false, signal);
            assert.ok(deep);
            assert.equal(requests.length, 3);
            assert.deepEqual(deep.drafts.map(d => d.message), ['helper', 'caller', 'docs']);
            for (const d of deep.drafts) {
                assert.ok(d.check);
                assert.ok(d.check.checks.includes('TypeScript'), d.check.skipped);
                assert.deepEqual(d.check.issues, []);
                assert.equal(d.check.existing, 1);
            }
            const prefix = (req: typeof requests[number]) => (req.body.input as unknown[])[0];
            assert.deepEqual(requests.map(prefix), Array(3).fill(prefix(requests[0])));
            deep.drafts[1].locked = true;
            deep.drafts[1].message = 'My reviewed message';
            await writeFile(join(root, 'later.md'), 'Outside the snapshot');
            // A bad first reply tries to take a locked edit. The retry may only assign IDs 1..3 excluding 1.
            replies = [groups(['steal', 1], ['helper', 2], ['docs', 3]), groups(['extract', 2], ['new docs title', 3])];
            const revised = await composition.refine(deep, 'Improve the other messages', signal);
            assert.ok(revised);
            assert.equal(requests.length, 5);
            assert.deepEqual(requests.map(prefix), Array(5).fill(prefix(requests[0])));
            assert.deepEqual(revised.drafts[1], deep.drafts[1]);
            assert.equal(revised.drafts[2].message, 'new docs title');
            const deltas: string[] = [];
            const reworded = await composition.reword(revised, 0, signal, delta => deltas.push(delta));
            assert.equal(deltas.join(''), subject);
            assert.ok(requests.every(r => r.body.stream === true));
            assert.equal(reworded?.drafts[0].message, subject);
            assert.ok(requests.every(r => r.body.model === splitModel));
            assert.equal(pickCount, 2);
            await assert.rejects(applyPlan(git, revised, false));
            assert.deepEqual(await git.headState(), before);
            assert.equal(await git.text(['diff', '--cached']), '');
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    test('Reuses verified draft boundaries on an identical split and replans when the guidance or diff changes', async function () {
        this.timeout(30000);
        const root = await mkdtemp(join(tmpdir(), 'pilot-repeat-split-'));
        try {
            const git = new ComposerGit(root, 'git');
            await git.run(['init', '-q', '-b', 'main']);
            for (const name of ['a', 'b', 'c', 'd', 'e']) { await writeFile(join(root, name), name); }
            const composition = new Composition(git, {
                getModel: () => 'model', setupModel: async () => undefined, getPrompt: () => '', log() {},
                getBaseURLandSecrets: async () => ({ provider: Venders.OpenAI, baseUrl, apiKey: 'test' }),
            });
            const five = [[1], [2], [3], [4], [5]], two = [[1, 2], [3, 4, 5]];
            const analysis = (groups: number[][]) => JSON.stringify({ drafts: groups.map(([id]) =>
                ({ purpose: 'Feature ' + id, paths: [], dependsOn: [], anchorEdit: id })) });
            const drafts = (groups: number[][]) => JSON.stringify({ commits: groups.map(edits => ({ message: 'Feature ' + edits[0], edits })) });
            const order = (groups: number[][]) => JSON.stringify({ order: groups.map((_, i) => i + 1) });
            async function run(guidance: string, answers: string[]) {
                requests.length = 0;
                replies = [...answers];
                const plan = await composition.start('working', guidance, false, new AbortController().signal);
                assert.equal(requests.length, answers.length);
                assert.ok(plan);
                return plan.drafts.map(draft => draft.edits);
            }
            assert.deepEqual(await run('', [analysis(five), drafts(five), order(five)]), five);
            assert.deepEqual(await run('', [drafts(two), drafts(five), order(five)]), five);
            assert.deepEqual(await run('Make two commits', [analysis(two), drafts(two), order(two)]), two);
            await writeFile(join(root, 'f'), 'additional change');
            const updated = [[1, 2], [3, 4, 5, 6]];
            assert.deepEqual(await run('Make two commits', [analysis(updated), drafts(updated), order(updated)]), updated);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    for (const provider of [Venders.OpenAI, Venders.Anthropic]) {
        test(provider + ' streams into SCM, restores interrupted output and respects manual edits', async function () {
            this.timeout(15000);
            for (const outcome of ['success', 'interrupted', 'edited'] as const) {
                let stream: ReturnType<typeof modelStream>;
                let disconnect: () => void;
                streamReply = res => {
                    stream = modelStream(res, provider, 'model', { input_tokens: 4, output_tokens: 2 });
                    disconnect = () => res.end();
                    stream.write('fix:');
                };
                let firstWrite!: () => void;
                const preview = new Promise<void>(resolve => { firstWrite = resolve; });
                const { generator, repo, log } = commitGenerator('model', provider, message => {
                    if (message === 'fix:') { firstWrite(); }
                });
                requests.length = 0;
                repo.inputBox.value = 'original draft';
                const run = generator.run();
                await Promise.race([preview, run.then(() => assert.fail('run ended before a preview was written'))]);
                assert.equal(repo.inputBox.value, 'fix:');
                const duplicate = generator.run();
                if (outcome === 'edited') { repo.inputBox.value = 'my own edit'; }
                if (outcome === 'interrupted') { disconnect!(); }
                else { stream!.write(' correct timeout'); stream!.finish(); }
                await Promise.all([run, duplicate]);
                const expected = { success: subject, interrupted: 'original draft', edited: 'my own edit' };
                assert.equal(repo.inputBox.value, expected[outcome]);
                assert.equal(requests.length, 1);
                const events = log.map(line => JSON.parse(line));
                assert.equal(events.filter(event => event.event === 'task.started').length, 1);
                assert.equal(events.at(-1).status, { success: 'completed', interrupted: 'failed', edited: 'cancelled' }[outcome]);
            }
        });

        test(provider + ' exposes the first draft before the server sends the second', async function () {
            this.timeout(15000);
            const root = await mkdtemp(join(tmpdir(), 'pilot-stream-'));
            const first = '{"commits":[{"message":"Fix } in a string","edits":[1]}';
            const tail = ',{"message":"Update guide","edits":[2]}]}';
            let finish: () => void;
            let interrupt: () => void;
            let releaseFirst: () => void;
            let waitForConnection = true;
            streamReply = res => {
                const stream = modelStream(res, provider, 'model', { input_tokens: 100, output_tokens: 20 }, waitForConnection);
                interrupt = () => res.end();
                releaseFirst = () => {
                    stream.write(first.slice(0, 23));
                    stream.write(first.slice(23));
                };
                if (!waitForConnection) { releaseFirst(); }
                finish = () => { stream.write(tail); stream.finish(); };
            };
            try {
                const git = new ComposerGit(root, 'git');
                await git.run(['init', '-q']);
                await writeFile(join(root, 'a'), 'one');
                await writeFile(join(root, 'b'), 'two');
                const composition = new Composition(git, {
                    getModel: () => 'model', setupModel: async () => undefined, getPrompt: () => '', log() {},
                    getBaseURLandSecrets: async () => ({ provider, baseUrl, apiKey: 'test' }),
                });
                const events: DraftProgress[] = [];
                const t = vscode.l10n.t;
                requests.length = 0;
                const result = await composition.start('working', 'two commits', false, new AbortController().signal, 'quick', event => {
                    events.push(event);
                    if (event.type === 'status' && event.text === t('Waiting for draft text…')) { releaseFirst(); }
                    if (event.type === 'append' && event.draft.paths.includes('a')) { finish(); }
                });
                const steps = events.flatMap(event => {
                    if (event.type === 'status') { return [event.text]; }
                    if (event.type === 'append') { return [event.draft.message]; }
                    return [];
                });
                assert.deepEqual(steps, [
                    t('Reading selected changes…'),
                    t('Read {0} changed files.', 2),
                    t('Sending the grouping request and waiting for a response…'),
                    t('Waiting for draft text…'),
                    t('Receiving draft groups…'),
                    'Fix } in a string',
                    'Update guide',
                    t('Preparing draft diffs ({0}/{1})…', 0, 2),
                    t('Preparing draft diffs ({0}/{1})…', 1, 2),
                    t('Checking the starting tree…'),
                    t('Draft checks complete: {0}/{1}', 0, 2),
                    t('Draft checks complete: {0}/{1}', 1, 2),
                    t('Draft checks complete: {0}/{1}', 2, 2),
                ]);
                const status = events.filter(event => event.type === 'status');
                assert.deepEqual(status.flatMap(event => event.step ? [event.step] : []),
                    ['changes', 'changes', 'grouping', 'grouping', 'grouping']);
                const timestamps = status.map(event => event.at);
                assert.ok(timestamps.every((time, index) => index === 0 || time >= timestamps[index - 1]));
                const checks = events.filter(event => event.type === 'check');
                assert.deepEqual(checks.slice(0, 2).map(event => [event.index, event.result]), [[0, undefined], [1, undefined]]);
                assert.deepEqual(checks.filter(event => event.result).map(event => event.index).sort(), [0, 1]);
                assert.deepEqual(events.filter(e => e.type === 'append').map(e => e.draft), [
                    { id: '1', message: 'Fix } in a string', paths: ['a'] }, { id: '2', message: 'Update guide', paths: ['b'] },
                ]);
                assert.deepEqual(result?.drafts.map(d => d.message), ['Fix } in a string', 'Update guide']);
                assert.deepEqual(events.filter(e => e.type === 'diff').map(e => e.files[0].patch),
                    result?.drafts.map(d => d.files[0].patch));
                assert.equal(requests.length, 1);
                waitForConnection = false;
                const cancelled: DraftProgress[] = [];
                const abort = new AbortController();
                const stopped = await composition.start('working', '', false, abort.signal, 'quick', event => {
                    cancelled.push(event);
                    if (event.type === 'append') { abort.abort(); }
                });
                assert.equal(stopped, undefined);
                assert.equal(cancelled.filter(event => event.type === 'append').length, 1);
                assert.ok(!cancelled.some(event => event.type === 'diff'));

                // A clean HTTP EOF after a complete draft is still an incomplete provider response.
                await assert.rejects(composition.start('working', '', false, new AbortController().signal, 'quick', event => {
                    if (event.type === 'append') { interrupt(); }
                }));
                assert.equal(requests.length, 3);
                assert.equal((await git.headState()).head, '');
            } finally { await rm(root, { recursive: true, force: true }); }
        });
    }

    test('Falls back once when a compatible endpoint explicitly rejects streaming', async () => {
        streamReply = res => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Parameter stream is not supported' } }));
        };
        const adaptor = new OpenAIAdaptor(baseUrl, 'test', Venders.OpenAI);
        requests.length = 0;
        const response = await adaptor.createMessage({ model: 'gpt-6.1-sol', avoidCacheWrites: true,
            messages: [{ role: MessageRole.USER, content: diff }], max_output_tokens: 32 });
        assert.equal(response.content[0].text, subject);
        assert.deepEqual(requests.map(r => r.body.stream), [true, undefined]);
        assert.deepEqual(requests[0].body.prompt_cache_options, requests[1].body.prompt_cache_options);
    });

    test('Preserves default caching for calls that do not request one-off behavior', async () => {
        const adaptor = new OpenAIAdaptor(baseUrl, 'test', Venders.OpenAI);
        await adaptor.createMessage({ model: 'gpt-6.1-sol', messages: [{ role: MessageRole.USER, content: diff }], max_output_tokens: 32 });
        assert.ok(!('prompt_cache_options' in requests.at(-1)!.body));
    });
});
