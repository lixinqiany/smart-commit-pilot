import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

suite('Commit message prompt caching', () => {
    const diff = 'diff --git a/settings.ts b/settings.ts\n-old\n+new';
    const subject = 'fix: correct timeout';
    let baseUrl: string;
    let replies: string[] = [];
    teardown(() => { replies = []; });
    let inputDetails: { cached_tokens: number; cache_write_tokens?: number } | undefined;
    const requests: { path?: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
        }
        const body = JSON.parse(raw);
        requests.push({ path: req.url, body });
        const reply = replies.shift() ?? subject;
        const usage = { input_tokens: 2728, output_tokens: 17, input_tokens_details: inputDetails };
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

    async function generate(model: string, provider = Venders.OpenAI) {
        const log: string[] = [];
        const repo = { rootUri: vscode.Uri.file('/test'), inputBox: { value: '' } } as Repository;
        const git = {
            getRepository: () => repo,
            hasStagedChanges: () => true,
            getStagedDiff: async () => diff,
            setCommitMessage: GitService.prototype.setCommitMessage,
        };
        const config = {
            getBaseURLandSecrets: async () => ({ provider, baseUrl, apiKey: 'test' }),
            getModel: () => model,
            getPrompt: () => 'Write a subject.',
            log: (line: string) => log.push(line),
        };
        requests.length = 0;
        await new CommitGenerator(git, config).run();
        assert.equal(repo.inputBox.value, subject, log.join('\n'));
        assert.equal(requests.length, 1);
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

    test('Logs actual cache writes and distinguishes missing counts from zero', async () => {
        const t = vscode.l10n.t;
        for (inputDetails of [{ cached_tokens: 0, cache_write_tokens: 0 },
            { cached_tokens: 0, cache_write_tokens: 2725 }, { cached_tokens: 64 }, undefined]) {
            const { log } = await generate('gpt-6.1-sol');
            assert.ok(log.includes(t('Prompt cache tokens: {0} read, {1} written.',
                inputDetails?.cached_tokens ?? t('not reported'), inputDetails?.cache_write_tokens ?? t('not reported'))));
        }
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
            const composition = new Composition(git, { getModel: () => 'gpt-6.1-sol', getPrompt: () => 'Write a subject.',
                setupModel: async () => {}, log() {}, getBaseURLandSecrets: async () => ({ provider: Venders.OpenAI, baseUrl, apiKey: 'test' }) });
            const signal = new AbortController().signal;
            const groups = (...items: [string, number][]) => JSON.stringify({ commits: items.map(([message, id]) => ({ message, edits: [id] })) });
            await writeFile(join(root, 'z.md'), 'Guide');
            requests.length = 0;
            replies = [groups(['docs', 1])];
            const quick = await composition.start('working', '', false, signal);
            assert.equal(requests.length, 1);
            assert.equal(quick?.session?.deep, false);
            assert.equal(JSON.stringify(requests[0].body).includes('prompt_cache_breakpoint'), false);

            await writeFile(join(root, 'caller.ts'), "export { shared } from './shared';");
            await writeFile(join(root, 'shared.ts'), 'export const shared = 1;');
            requests.length = 0;
            replies = [JSON.stringify({ concerns: [{ purpose: 'Extract helper', paths: ['shared.ts'], dependsOn: [] }] }),
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
            await assert.rejects(applyPlan(git, revised, false));
            assert.deepEqual(await git.headState(), before);
            assert.equal(await git.text(['diff', '--cached']), '');
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    test('Preserves default caching for calls that do not request one-off behavior', async () => {
        const adaptor = new OpenAIAdaptor(baseUrl, 'test', Venders.OpenAI);
        await adaptor.createMessage({ model: 'gpt-6.1-sol', messages: [{ role: MessageRole.USER, content: diff }], max_output_tokens: 32 });
        assert.ok(!('prompt_cache_options' in requests.at(-1)!.body));
    });
});
