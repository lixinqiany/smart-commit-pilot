import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
    let inputDetails: { cached_tokens: number; cache_write_tokens?: number } | undefined;
    const requests: { path?: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
        }
        const body = JSON.parse(raw);
        requests.push({ path: req.url, body });
        const usage = { input_tokens: 2728, output_tokens: 17, input_tokens_details: inputDetails };
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(req.url === '/v1/messages'
            ? { model: body.model, content: [{ type: 'text', text: subject }], usage }
            : { model: body.model, output: [{ type: 'message', content: [{ type: 'output_text', text: subject }] }], usage }));
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

    test('Preserves default caching for calls that do not request one-off behavior', async () => {
        const adaptor = new OpenAIAdaptor(baseUrl, 'test', Venders.OpenAI);
        await adaptor.createMessage({ model: 'gpt-6.1-sol', messages: [{ role: MessageRole.USER, content: diff }], max_output_tokens: 32 });
        assert.ok(!('prompt_cache_options' in requests.at(-1)!.body));
    });
});
