import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { logTokenUsage } from '../adaptor/logTokenUsage';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { Configurator } from '../configuration/Configurator';
import { Venders } from '../configuration/configuration.constants';
import { GitService } from '../git/GitService';
import { Repository } from '../git/typings/git';
import { applyPlan } from './apply';
import { collectChanges } from './changes';
import { ComposerGit, Scope, withScratch } from './git';
import { buildPlan, parseGroups, planningRequest } from './plan';
import { ReviewPanel } from './ReviewPanel';

const t = vscode.l10n.t;

export class Composer {
    private readonly panels = new Map<string, ReviewPanel>();
    private readonly preparing = new Set<string>();

    constructor(private readonly extensionUri: vscode.Uri, private readonly service: GitService,
        private readonly config: Configurator) {}

    dispose(): void { for (const panel of this.panels.values()) { panel.dispose(); } }

    private async repository(root?: vscode.Uri): Promise<Repository | undefined> {
        if (root || this.service.api.repositories.length <= 1) { return this.service.getRepository(root); }
        const choices = this.service.api.repositories.map(repo => ({
            label: basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, repo,
        }));
        return (await vscode.window.showQuickPick(choices, { title: t('Select a repository') }))?.repo;
    }

    async run(root?: vscode.Uri): Promise<void> {
        try {
            const repo = await this.repository(root);
            if (!repo) { return; }
            const path = repo.rootUri.fsPath;
            const existing = this.panels.get(path);
            if (existing) { existing.reveal(); return; }
            if (this.preparing.has(path)) { return; }
            this.preparing.add(path);
            try {
                const scopes = [
                    { label: t('Staged changes'), description: t('Split only the changes in the index'), scope: 'staged' as const },
                    { label: t('Working tree'), description: t('Use current file contents, including untracked files'), scope: 'working' as const },
                ];
                if (!this.service.hasStagedChanges(repo)) { scopes.reverse(); }
                const choice = await vscode.window.showQuickPick(scopes, { title: t('Split changes into commits'),
                    placeHolder: t('Choose which changes to send to your AI provider') });
                if (!choice) { return; }
                const git = new ComposerGit(path, this.service.api.git.path);
                const generate = (guidance: string) => this.generate(git, choice.scope, guidance);
                const plan = await generate('');
                if (!plan) { return; }
                const panel = new ReviewPanel(this.extensionUri, basename(path), plan, generate,
                    async reviewed => {
                        const sign = vscode.workspace.getConfiguration('git', repo.rootUri).get<boolean>('enableCommitSigning', false);
                        await applyPlan(git, reviewed, sign);
                    }, () => this.panels.delete(path));
                this.panels.set(path, panel);
            } finally { this.preparing.delete(path); }
        } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    }

    private async generate(git: ComposerGit, scope: Scope, guidance: string) {
        const vendor = await this.config.getBaseURLandSecrets();
        const model = this.config.getModel();
        if (!vendor || !model) { throw new Error(t('Configure a provider and select a model before splitting commits.')); }
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
            title: t('Preparing split commits…'), cancellable: true }, async (progress, token) => {
            const snapshot = await withScratch(dir => git.capture(scope, join(dir, 'index')));
            if (snapshot.base === snapshot.target) { throw new Error(t('No changes in the selected scope.')); }
            const files = await collectChanges(git, snapshot);
            if (token.isCancellationRequested) { return; }
            progress.report({ message: t('Grouping changes with {0}…', model) });
            const adaptor = AdaptorFactory.create(vendor.provider as Venders, vendor.baseUrl, vendor.apiKey);
            const abort = new AbortController();
            const subscription = token.onCancellationRequested(() => abort.abort());
            let response;
            try {
                response = await adaptor.createMessage(planningRequest(model, files, this.config.getPrompt(), guidance), abort.signal);
            } catch (err) {
                if (token.isCancellationRequested) { return; }
                throw err;
            } finally { subscription.dispose(); }
            if (token.isCancellationRequested) { return; }
            logTokenUsage(response.usage, line => this.config.log(line));
            const groups = parseGroups(response.content.map(c => c.text).join('\n'), files);
            progress.report({ message: t('Building commit previews…') });
            const plan = await buildPlan(git, snapshot, files, groups);
            return token.isCancellationRequested ? undefined : plan;
        });
    }
}
