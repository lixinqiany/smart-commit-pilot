import * as vscode from 'vscode';
import { GitService } from './GitService';
import { Configurator } from '../configuration/Configurator';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { Venders } from '../configuration/configuration.constants';
import { MessageRole } from '../adaptor/unified-protocols/request';

const MAX_OUTPUT_TOKENS = 1024;

const PROMPT_PREFIX =
    'You are a commit message generator. Given a git diff of staged changes, write a single commit message following the Conventional Commits specification, validated against @commitlint/config-conventional rules.';

export class CommitGenerator {
    constructor(
        private readonly gitService: GitService,
        private readonly configurator: Configurator
    ) {}

    async run(rootUri?: vscode.Uri): Promise<void> {
        console.log(`[SmartCommitPilot] generate triggered for rootUri=${rootUri?.toString() ?? '(default repo)'}`);

        const repository = this.gitService.getRepository(rootUri);
        console.log(`[SmartCommitPilot] resolved repository rootUri=${repository.rootUri.toString()}`);

        if (!this.gitService.hasStagedChanges(repository)) {
            console.log('[SmartCommitPilot] no staged changes, aborting');
            vscode.window.showWarningMessage('Smart Commit Pilot: no staged changes to generate a commit message from.');
            return;
        }

        const venderInfo = await this.configurator.getBaseURLandSecrets();
        if (!venderInfo) {
            console.log('[SmartCommitPilot] no vendor configured, aborting');
            vscode.window.showErrorMessage('Smart Commit Pilot: please setup the provider first.');
            return;
        }
        const model = this.configurator.getModel();
        if (!model) {
            console.log('[SmartCommitPilot] no model selected, aborting');
            vscode.window.showErrorMessage('Smart Commit Pilot: please select a model first.');
            return;
        }
        console.log(`[SmartCommitPilot] using provider=${venderInfo.provider} model=${model}`);

        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Generating commit message...' },
                async () => {
                    const diff = await this.gitService.getStagedDiff(repository);
                    console.log(`[SmartCommitPilot] staged diff fetched (${diff.length} chars)`);

                    const adaptor = AdaptorFactory.create(venderInfo.provider as Venders, venderInfo.baseUrl, venderInfo.apiKey);
                    const response = await adaptor.createMessage({
                        model,
                        system: `${PROMPT_PREFIX}\n\n${this.configurator.getPrompt()}`,
                        max_output_tokens: MAX_OUTPUT_TOKENS,
                        messages: [{ role: MessageRole.USER, content: diff }],
                    });
                    console.log(`[SmartCommitPilot] received response with ${response.content.length} content part(s)`);
                    if (response.usage) {
                        console.log(
                            `[SmartCommitPilot] token usage: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`
                        );
                    }

                    const message = response.content
                        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                        .map((part) => part.text)
                        .join('\n');
                    console.log(`[SmartCommitPilot] writing commit message (${message.length} chars) to input box`);
                    this.gitService.setCommitMessage(message, repository);
                }
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[SmartCommitPilot] generate failed', error);
            vscode.window.showErrorMessage(`Smart Commit Pilot: failed to generate commit message. ${message}`);
        }
    }
}
