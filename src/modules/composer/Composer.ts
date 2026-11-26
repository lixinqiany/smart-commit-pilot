import { basename } from 'node:path';
import * as vscode from 'vscode';
import { Configurator } from '../configuration/Configurator';
import { GitService } from '../git/GitService';
import { Repository } from '../git/typings/git';
import { applyPlan } from './apply';
import { Composition } from './Composition';
import { ComposerGit } from './git';
import { ReviewPanel } from './ReviewPanel';

const t = vscode.l10n.t;

export class Composer {
    private readonly panels = new Map<string, ReviewPanel>();
    private readonly compositions = new Map<string, Composition>();
    private readonly repositoryClosed: vscode.Disposable;

    constructor(private readonly extension: vscode.Extension<unknown>, private readonly service: GitService,
        private readonly config: Configurator) {
        this.repositoryClosed = service.api.onDidCloseRepository(repo => this.compositions.delete(repo.rootUri.fsPath));
    }

    dispose(): void {
        this.repositoryClosed.dispose();
        for (const panel of this.panels.values()) { panel.dispose(); }
        this.compositions.clear();
    }

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
            const git = new ComposerGit(path, this.service.api.git.path);
            let composition = this.compositions.get(path);
            if (!composition) {
                composition = new Composition(git, this.config);
                this.compositions.set(path, composition);
            }
            const heading = { product: this.extension.packageJSON.displayName as string, repo: basename(path),
                showRepo: this.service.api.repositories.length > 1 };
            const panel = new ReviewPanel(this.extension.extensionUri, heading, this.service.hasStagedChanges(repo),
                composition,
                async reviewed => {
                    const sign = vscode.workspace.getConfiguration('git', repo.rootUri).get<boolean>('enableCommitSigning', false);
                    await applyPlan(git, reviewed, sign);
                }, () => this.panels.delete(path));
            this.panels.set(path, panel);
        } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    }

}
