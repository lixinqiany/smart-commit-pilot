import * as vscode from 'vscode';
import { GitService } from './GitService';
import type { Repository } from './typings/git';
import { Configurator } from '../configuration/Configurator';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { Venders } from '../configuration/configuration.constants';
import { TaskLog } from '../configuration/TaskLog';
import { messageRequest } from './messageRequest';

const t = vscode.l10n.t;

export class CommitGenerator {
    private readonly pending = new Map<string, Promise<void>>();

    constructor(
        private readonly gitService: Pick<GitService, 'getRepository' | 'hasStagedChanges' | 'getStagedDiff' | 'setCommitMessage'>,
        private readonly configurator: Pick<Configurator, 'getBaseURLandSecrets' | 'getModel' | 'getPrompt' | 'log'>
    ) {}

    async run(rootUri?: vscode.Uri): Promise<void> {
        const repository = this.gitService.getRepository(rootUri);
        const key = repository.rootUri.toString();
        const pending = this.pending.get(key);
        if (pending) { return pending; }
        const generation = TaskLog.run(line => this.configurator.log(line), 'generate_commit_message', { repository: key },
            task => this.generate(repository, task)).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(t('Smart Git Pilot: could not generate a commit message. {0}', message));
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, generation);
        return generation;
    }

    private async generate(repository: Repository, task: TaskLog): Promise<void> {
        const original = repository.inputBox.value;

        if (!this.gitService.hasStagedChanges(repository)) {
            task.stop('skipped', 'no_staged_changes');
            void vscode.window.showWarningMessage(t('Smart Git Pilot: stage changes before generating a commit message.'));
            return;
        }

        const venderInfo = await this.configurator.getBaseURLandSecrets();
        if (!venderInfo) {
            task.stop('skipped', 'provider_not_configured');
            void vscode.window.showErrorMessage(t('Smart Git Pilot: configure a provider first.'));
            return;
        }
        const model = this.configurator.getModel();
        if (!model) {
            task.stop('skipped', 'model_not_selected');
            void vscode.window.showErrorMessage(t('Smart Git Pilot: select a model first.'));
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: t('Generating commit message…'), cancellable: true,
        }, async (_progress, token) => {
            const abort = new AbortController();
            const subscription = token.onCancellationRequested(() => abort.abort());
            let lastWritten = original;
            let edited = false;
            const write = (text: string) => {
                if (repository.inputBox.value !== lastWritten) { edited = true; abort.abort(); }
                if (abort.signal.aborted || text === lastWritten) { return; }
                this.gitService.setCommitMessage(text, repository);
                lastWritten = text;
            };
            try {
                if (token.isCancellationRequested) { abort.abort(); return; }
                const diff = await this.gitService.getStagedDiff(repository);
                abort.signal.throwIfAborted();
                task.progress('read_staged_changes', { characters: diff.length });
                const adaptor = AdaptorFactory.create(venderInfo.provider as Venders, venderInfo.baseUrl, venderInfo.apiKey);
                const request = messageRequest(model, diff, this.configurator.getPrompt());
                let preview = '';
                const response = await task.modelCall({ provider: venderInfo.provider, model, step: 'write_message', attempt: 1 },
                    abort.signal, () => adaptor.createMessage(request, abort.signal, delta => { preview += delta; write(preview); }));
                const message = response.content.map(part => part.text).join('\n');
                if (!message.trim()) { throw new Error(t('The model returned an empty commit message.')); }
                write(message);
                if (!abort.signal.aborted) { task.progress('write_commit_message', { characters: message.length }); }
            } catch (error) {
                if (repository.inputBox.value === lastWritten && lastWritten !== original) {
                    this.gitService.setCommitMessage(original, repository);
                }
                if (!abort.signal.aborted) { throw error; }
            } finally {
                if (abort.signal.aborted) { task.stop('cancelled', edited ? 'commit_message_edited' : undefined); }
                subscription.dispose();
            }
        });
    }
}
