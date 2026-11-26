import * as vscode from 'vscode';
import { GitService } from './GitService';
import { Configurator } from '../configuration/Configurator';
import { logTokenUsage } from '../adaptor/logTokenUsage';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { Venders } from '../configuration/configuration.constants';
import { MessageRole } from '../adaptor/unified-protocols/request';

const MAX_OUTPUT_TOKENS = 1024;
const t = vscode.l10n.t;

const PROMPT_PREFIX =
    'You are a commit message generator. Given a git diff of staged changes, write a single commit message following the Conventional Commits specification, validated against @commitlint/config-conventional rules.';

export class CommitGenerator {
    constructor(
        private readonly gitService: Pick<GitService, 'getRepository' | 'hasStagedChanges' | 'getStagedDiff' | 'setCommitMessage'>,
        private readonly configurator: Pick<Configurator, 'getBaseURLandSecrets' | 'getModel' | 'getPrompt' | 'log'>
    ) {}

    async run(rootUri?: vscode.Uri): Promise<void> {
        this.configurator.log(rootUri ? t('Generating for {0}.', rootUri.toString()) : t('Generating for the default repository.'));

        const repository = this.gitService.getRepository(rootUri);
        this.configurator.log(t('Repository: {0}', repository.rootUri.toString()));

        if (!this.gitService.hasStagedChanges(repository)) {
            const message = t('Smart Git Pilot: stage changes before generating a commit message.');
            this.configurator.log(message);
            vscode.window.showWarningMessage(message);
            return;
        }

        const venderInfo = await this.configurator.getBaseURLandSecrets();
        if (!venderInfo) {
            const message = t('Smart Git Pilot: configure a provider first.');
            this.configurator.log(message);
            vscode.window.showErrorMessage(message);
            return;
        }
        const model = this.configurator.getModel();
        if (!model) {
            const message = t('Smart Git Pilot: select a model first.');
            this.configurator.log(message);
            vscode.window.showErrorMessage(message);
            return;
        }
        this.configurator.log(t('Using provider {0} and model {1}.', venderInfo.provider, model));

        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t('Generating commit message…') },
                async () => {
                    const diff = await this.gitService.getStagedDiff(repository);
                    this.configurator.log(t('Read staged changes ({0} characters).', diff.length));

                    const adaptor = AdaptorFactory.create(venderInfo.provider as Venders, venderInfo.baseUrl, venderInfo.apiKey);
                    const response = await adaptor.createMessage({
                        model,
                        avoidCacheWrites: true,
                        system: `${PROMPT_PREFIX}\n\n${this.configurator.getPrompt()}`,
                        max_output_tokens: MAX_OUTPUT_TOKENS,
                        messages: [{ role: MessageRole.USER, content: diff }],
                    });
                    this.configurator.log(t('Response parts received: {0}.', response.content.length));
                    logTokenUsage(response.usage, line => this.configurator.log(line));

                    const message = response.content
                        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                        .map((part) => part.text)
                        .join('\n');
                    this.configurator.log(t('Writing the commit message ({0} characters).', message.length));
                    this.gitService.setCommitMessage(message, repository);
                }
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
            const notification = t('Smart Git Pilot: could not generate a commit message. {0}', message);
            this.configurator.log(notification + stack);
            vscode.window.showErrorMessage(notification);
        }
    }
}
