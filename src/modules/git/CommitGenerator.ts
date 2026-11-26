import * as vscode from 'vscode';
import { GitService } from './GitService';
import type { Repository } from './typings/git';
import { Configurator } from '../configuration/Configurator';
import { logTokenUsage } from '../adaptor/logTokenUsage';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { Venders } from '../configuration/configuration.constants';
import { messageRequest } from './messageRequest';

const t = vscode.l10n.t;

export class CommitGenerator {
    private readonly pending = new Map<string, Promise<void>>();

    constructor(
        private readonly gitService: Pick<GitService, 'getRepository' | 'hasStagedChanges' | 'getStagedDiff' | 'setCommitMessage'>,
        private readonly configurator: Pick<Configurator, 'getBaseURLandSecrets' | 'getModel' | 'getPrompt' | 'log'>
    ) {}

    async run(rootUri?: vscode.Uri): Promise<void> {
        this.configurator.log(rootUri ? t('Generating for {0}.', rootUri.toString()) : t('Generating for the default repository.'));

        const repository = this.gitService.getRepository(rootUri);
        const key = repository.rootUri.toString();
        const pending = this.pending.get(key);
        if (pending) { return pending; }
        const generation = this.generate(repository).finally(() => this.pending.delete(key));
        this.pending.set(key, generation);
        return generation;
    }

    private async generate(repository: Repository): Promise<void> {
        const original = repository.inputBox.value;
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
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, title: t('Generating commit message…'), cancellable: true,
            }, async (_progress, token) => {
                const abort = new AbortController();
                const subscription = token.onCancellationRequested(() => abort.abort());
                let lastWritten = original;
                const write = (text: string) => {
                    if (repository.inputBox.value !== lastWritten) { abort.abort(); }
                    if (abort.signal.aborted || text === lastWritten) { return; }
                    this.gitService.setCommitMessage(text, repository);
                    lastWritten = text;
                };
                try {
                    if (token.isCancellationRequested) { return; }
                    const diff = await this.gitService.getStagedDiff(repository);
                    abort.signal.throwIfAborted();
                    this.configurator.log(t('Read staged changes ({0} characters).', diff.length));
                    const adaptor = AdaptorFactory.create(venderInfo.provider as Venders, venderInfo.baseUrl, venderInfo.apiKey);
                    let preview = '';
                    const response = await adaptor.createMessage(messageRequest(model, diff, this.configurator.getPrompt()), abort.signal,
                        delta => { preview += delta; write(preview); });
                    this.configurator.log(t('Response parts received: {0}.', response.content.length));
                    logTokenUsage(response.usage, line => this.configurator.log(line));
                    const message = response.content.map(part => part.text).join('\n');
                    if (!message.trim()) { throw new Error(t('The model returned an empty commit message.')); }
                    this.configurator.log(t('Writing the commit message ({0} characters).', message.length));
                    write(message);
                } catch (error) {
                    if (repository.inputBox.value === lastWritten && lastWritten !== original) {
                        this.gitService.setCommitMessage(original, repository);
                    }
                    if (!abort.signal.aborted) { throw error; }
                } finally { subscription.dispose(); }
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
            const notification = t('Smart Git Pilot: could not generate a commit message. {0}', message);
            this.configurator.log(notification + stack);
            vscode.window.showErrorMessage(notification);
        }
    }
}
