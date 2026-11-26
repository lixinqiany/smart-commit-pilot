import * as vscode from 'vscode';
import { basename } from 'node:path';
import { GitService, BranchRef } from './GitService';
import { BRANCH_VIEW as VIEW, BranchMode, BranchNode, BranchTree, EMPTY_FILE_SCHEME, TreeNode } from './BranchTree';
import { Repository } from './typings/git';
import { commitFileDecorations } from './CommitFiles';
import { pickBranchDeletion } from './branchDeletionPicker';
import { TaskLog } from '../configuration/TaskLog';

const t = vscode.l10n.t;

export class BranchesView implements vscode.Disposable {
    private readonly tree: BranchTree;
    private readonly listeners = new Map<string, vscode.Disposable>();
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly git: GitService, private readonly state: vscode.Memento, private readonly log: (line: string) => void) {
        this.tree = new BranchTree(git, state.get<BranchMode>(VIEW + '.mode', 'local'),
            state.get(VIEW + '.localTree', false), state.get(VIEW + '.allContributors', false));
        void vscode.commands.executeCommand('setContext', VIEW + '.mode', this.tree.mode);
        const watch = (repo: Repository) => {
            this.listeners.set(repo.rootUri.toString(), repo.state.onDidChange(() => this.tree.refresh()));
        };
        git.api.repositories.forEach(watch);
        this.disposables = [
            this.tree,
            vscode.window.registerTreeDataProvider(VIEW, this.tree),
            vscode.window.registerFileDecorationProvider(commitFileDecorations),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('smartCommitPilot.blame.avatars')) {
                    this.tree.refresh();
                }
            }),
            vscode.workspace.registerTextDocumentContentProvider(EMPTY_FILE_SCHEME, { provideTextDocumentContent: () => '' }),
            vscode.commands.registerCommand(VIEW + '.more', (node?: TreeNode) => {
                if (node?.kind === 'more') {
                    this.tree.showMore(node);
                }
            }),
            git.api.onDidOpenRepository(repo => {
                watch(repo);
                this.tree.refresh();
            }),
            git.api.onDidCloseRepository(repo => {
                this.listeners.get(repo.rootUri.toString())?.dispose();
                this.listeners.delete(repo.rootUri.toString());
                this.tree.refresh();
            }),
            vscode.commands.registerCommand(VIEW + '.refresh', () => this.tree.refresh()),
            ...(['local', 'remote', 'tags', 'contributors'] as const).flatMap(mode => [
                vscode.commands.registerCommand(VIEW + '.' + mode, () => this.setMode(mode)),
                vscode.commands.registerCommand(VIEW + '.' + mode + 'Active', () => this.setMode(mode)),
            ]),
            this.command('listLayout', () => this.setLocalLayout(false)),
            this.command('treeLayout', () => this.setLocalLayout(true)),
            this.command('allContributors', () => this.setContributorScope(true)),
            this.command('currentContributors', () => this.setContributorScope(false)),
            this.command('actions', node => this.actions(node?.kind === 'branch' ? node : undefined)),
            this.command('switch', node => this.switchBranch(node?.kind === 'local' ? node : undefined)),
            this.command('create', node => this.createBranch(node?.kind === 'local' ? node : undefined)),
            this.command('addRemote', node => this.addRemote(node?.repo)),
            this.command('switchTo', node => this.switchBranch(node)),
            this.command('fetch', async node => {
                if (node?.kind === 'branch') {
                    await this.git.fetchBranch(node.repo, node.branch);
                }
            }),
            this.command('createFrom', node => this.createBranch(node)),
            this.command('delete', node => this.deleteBranch(node)),
        ];
    }

    dispose(): void {
        this.listeners.forEach(listener => listener.dispose());
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private command(id: string, run: (node?: TreeNode) => Promise<void>): vscode.Disposable {
        return vscode.commands.registerCommand(VIEW + '.' + id, async (node?: TreeNode) => {
            try {
                await run(node);
            } catch (error) {
                void vscode.window.showErrorMessage(t('Branch operation failed. {0}',
                    error instanceof Error ? error.message : String(error)));
            } finally {
                this.tree.refresh();
            }
        });
    }

    private async setMode(mode: BranchMode): Promise<void> {
        this.tree.mode = mode;
        this.tree.refresh();
        await Promise.all([
            this.state.update(VIEW + '.mode', mode),
            vscode.commands.executeCommand('setContext', VIEW + '.mode', mode),
        ]);
    }

    private async setLocalLayout(tree: boolean): Promise<void> {
        if (this.tree.mode === 'local') {
            this.tree.localTreeLayout = tree;
            await this.state.update(VIEW + '.localTree', tree);
        }
    }

    private async setContributorScope(all: boolean): Promise<void> {
        this.tree.allContributors = all;
        await this.state.update(VIEW + '.allContributors', all);
    }

    private async addRemote(selected?: Repository): Promise<void> {
        const repo = selected ?? await this.pickRepo();
        if (!repo) {
            return;
        }
        const name = await vscode.window.showInputBox({
            title: t('Add remote'), prompt: t('Enter a remote name.'), placeHolder: 'upstream',
            validateInput: value => {
                if (!value || /^-|[\s\x00-\x1f]/u.test(value)) {
                    return t('Enter a valid remote name.');
                }
                return repo.state.remotes.some(remote => remote.name === value) ? t('Remote {0} already exists.', value) : undefined;
            },
        });
        if (!name) {
            return;
        }
        const url = await vscode.window.showInputBox({
            title: t('Add remote {0}', name), prompt: t('Enter the remote URL or a local repository path.'),
            validateInput: value => !value.trim() || /^-|[\r\n\x00]/u.test(value.trim()) ? t('Enter a valid remote address.') : undefined,
        });
        if (url) {
            await repo.addRemote(name, url.trim());
        }
    }

    private async pickRepo(): Promise<Repository | undefined> {
        const repos = this.git.api.repositories;
        if (repos.length === 1) {
            return repos[0];
        }
        if (!repos.length) {
            void vscode.window.showInformationMessage(t('Open a Git repository to manage branches.'));
            return;
        }
        const pick = await vscode.window.showQuickPick(repos.map(repo => ({
            label: basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, repo,
        })), { placeHolder: t('Select a repository') });
        return pick?.repo;
    }

    private async actions(node?: BranchNode): Promise<void> {
        if (!node) {
            return;
        }
        const { branch, repo } = node;
        const items = [{ label: t('Create branch from {0}…', branch.name), action: 'create' }];
        if (branch.fetchRemote) {
            items.unshift({ label: t('Fetch {0}', branch.name), action: 'fetch' });
        }
        if (!branch.current) {
            let label = t('Switch to {0}', branch.name);
            if (branch.remote) {
                const tracking = (await this.git.getBranches(repo)).filter(b => b.upstream === branch.ref);
                if (tracking.length === 1) {
                    label = t('Switch to local {0}', tracking[0].name);
                } else if (tracking.length) {
                    label = t('Select a local tracking branch…');
                } else {
                    label = t('Create a local branch tracking {0}…', branch.name);
                }
            }
            items.unshift({ label, action: 'switch' });
            if (!branch.remote) {
                items.push({ label: t('Delete local branch…'), action: 'delete' });
            }
        }
        const pick = await vscode.window.showQuickPick(items, { title: node.branch.name });
        if (pick?.action === 'create') {
            await this.createBranch(node);
        } else if (pick?.action === 'switch') {
            await this.switchBranch(node);
        } else if (pick?.action === 'fetch') {
            await this.git.fetchBranch(repo, branch);
        } else if (pick?.action === 'delete') {
            await this.deleteBranch(node);
        }
    }

    private async deleteBranch(node?: TreeNode): Promise<void> {
        if (node?.kind !== 'branch' || node.branch.remote || node.branch.current) {
            return;
        }
        const { repo, branch } = node;
        const plan = await this.git.getBranchDeletion(repo, branch.ref);
        const selected = await pickBranchDeletion(plan);
        if (selected) {
            await TaskLog.run(this.log, 'delete_branch', {
                repository: repo.rootUri.fsPath, branch: branch.name, force: selected.force,
                remote: selected.target?.remote, remoteRef: selected.target?.ref,
            }, task => this.git.deleteLocalBranch(repo, plan, selected, (step, detail) => task.progress(step, detail)));
        }
    }

    private async switchBranch(node?: TreeNode): Promise<void> {
        const repo = node?.repo ?? await this.pickRepo();
        if (!repo) {
            return;
        }
        const branches = await this.git.getBranches(repo);
        let target: BranchRef | undefined;
        if (node?.kind === 'branch') {
            target = branches.find(branch => branch.ref === node.branch.ref);
            if (!target) {
                throw new Error(t('Branch {0} no longer exists.', node.branch.name));
            }
        } else {
            const choices = branches.filter(branch => !branch.current).map(branch => ({
                label: branch.name, description: branch.remote ? t('Remote') : t('Local'), branch,
            }));
            if (!choices.length) {
                void vscode.window.showInformationMessage(t('There are no other branches to switch to.'));
                return;
            }
            const pick = await vscode.window.showQuickPick(choices, { placeHolder: t('Select a branch to switch to') });
            target = pick?.branch;
        }
        if (!target || target.current) {
            return;
        }
        if (!target.remote) {
            await this.git.switchBranch(repo, target.name);
            return;
        }

        const tracking = branches.filter(branch => !branch.remote && branch.upstream === target.ref);
        if (tracking.length) {
            const local = tracking.length === 1 ? tracking[0].name : await vscode.window.showQuickPick(
                tracking.map(branch => branch.name), { placeHolder: t('Select a local branch tracking {0}', target.name) });
            if (local) {
                await this.git.switchBranch(repo, local);
            }
            return;
        }

        // A remote name can itself contain a slash.
        const remote = target.fetchRemote;
        const suggested = target.name.slice((remote?.length ?? target.name.indexOf('/')) + 1);
        const name = await this.askName(target.name, branches, suggested);
        if (name) {
            await this.git.createBranch(repo, name, target.ref, 'track');
        }
    }

    private async createBranch(node?: TreeNode): Promise<void> {
        const repo = node?.repo ?? await this.pickRepo();
        if (!repo) {
            return;
        }
        const branches = await this.git.getBranches(repo);
        const base = node?.kind === 'branch' ? node.branch : branches.find(branch => branch.current);
        const startRef = base?.ref ?? repo.state.HEAD?.commit;
        if (!startRef) {
            void vscode.window.showInformationMessage(t('Make the first commit before creating a branch.'));
            return;
        }
        const baseLabel = base?.name ?? startRef.slice(0, 8);
        const name = await this.askName(baseLabel, branches);
        if (!name) {
            return;
        }
        const choice = await vscode.window.showQuickPick([
            { label: t('Create and switch to {0}', name), mode: 'switch' as const },
            { label: t('Create {0} and stay on the current branch', name), mode: 'create' as const },
        ], { title: t('Create branch from {0}', baseLabel) });
        if (choice) {
            await this.git.createBranch(repo, name, startRef, choice.mode);
        }
    }

    private async askName(base: string, branches: BranchRef[], suggested?: string): Promise<string | undefined> {
        return vscode.window.showInputBox({
            title: suggested ? t('Track {0} with a local branch', base) : t('Create branch from {0}', base),
            prompt: suggested ? t('Enter the local branch name to create and switch to.') : t('Enter the new local branch name.'),
            value: suggested,
            validateInput: name => {
                if (!name.trim()) {
                    return t('Enter a branch name.');
                }
                if (branches.some(branch => !branch.remote && branch.name === name)) {
                    return t('A local branch named {0} already exists.', name);
                }
                return undefined;
            },
        });
    }
}
