import * as vscode from 'vscode';
import { basename } from 'node:path';
import { BranchRef, GitService } from './GitService';
import { Repository } from './typings/git';
import { formatRelativeTime } from './formatRelativeTime';

export const BRANCH_VIEW = 'smart-commit-pilot.branches';
export type BranchMode = 'local' | 'remote';
export type BranchNode = { kind: 'branch'; repo: Repository; branch: BranchRef; label: string };
type RemoteGroup = { name: string; branches: BranchRef[] };
export type TreeNode = BranchNode
    | { kind: 'repo'; repo: Repository }
    | { kind: 'local'; repo: Repository; count: number }
    | { kind: 'remote'; repo: Repository; count: number }
    | { kind: 'server'; repo: Repository; remote: RemoteGroup }
    | { kind: 'folder'; repo: Repository; prefix: string; label: string; branches: BranchRef[] };

const t = vscode.l10n.t;
const { Expanded, Collapsed, None } = vscode.TreeItemCollapsibleState;

function groupRemotes(repo: Repository, refs: BranchRef[]): RemoteGroup[] {
    const groups = new Map<string, BranchRef[]>();
    const names = repo.state.remotes.map(remote => remote.name).sort((a, b) => b.length - a.length);
    for (const name of names) {
        groups.set(name, []);
    }
    for (const ref of refs) {
        // A remote name may contain slashes. Keep cached refs visible even if their config disappeared.
        const name = names.find(remote => ref.name.startsWith(remote + '/')) ?? ref.name.split('/')[0];
        const group = groups.get(name);
        if (group) {
            group.push(ref);
        } else {
            groups.set(name, [ref]);
        }
    }
    return Array.from(groups, ([name, branches]) => ({ name, branches }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function branchRows(repo: Repository, branches: BranchRef[], prefix: string, tree: boolean): TreeNode[] {
    const rows: TreeNode[] = [];
    const folders = new Map<string, BranchRef[]>();
    for (const branch of branches) {
        const label = branch.name.slice(prefix.length);
        const slash = label.indexOf('/');
        if (!tree || branch.current || slash < 0) {
            rows.push({ kind: 'branch', repo, branch, label });
            continue;
        }
        const name = label.slice(0, slash);
        const group = folders.get(name);
        if (group) {
            group.push(branch);
        } else {
            folders.set(name, [branch]);
        }
    }
    for (const [label, children] of folders) {
        if (children.length === 1) {
            const branch = children[0];
            rows.push({ kind: 'branch', repo, branch, label: branch.name.slice(prefix.length) });
        } else {
            let folder = prefix + label + '/';
            // Fold a chain such as feature/mobile into the first directory that actually branches.
            const subdirectories = children[0].name.slice(folder.length).split('/').slice(0, -1);
            for (const segment of subdirectories) {
                const next = folder + segment + '/';
                if (!children.every(branch => branch.name.startsWith(next))) {
                    break;
                }
                folder = next;
            }
            rows.push({ kind: 'folder', repo, prefix: folder, label: folder.slice(prefix.length, -1), branches: children });
        }
    }
    return rows;
}

export class BranchTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changes.event;

    constructor(private readonly git: GitService, public mode: BranchMode,
        public localTreeLayout: boolean) {}

    refresh(): void {
        this.changes.fire();
    }

    dispose(): void {
        this.changes.dispose();
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        switch (node?.kind) {
            case 'local':
            case 'remote':
            case 'branch': return [];
            case 'folder': return branchRows(node.repo, node.branches, node.prefix, true);
            case 'server': return branchRows(node.repo, node.remote.branches, node.remote.name + '/', false);
        }
        const repos = this.git.api.repositories;
        if (!node && repos.length !== 1) {
            return repos.map(repo => ({ kind: 'repo', repo }));
        }
        const repo = node?.repo ?? repos[0];
        const refs = await this.git.getBranches(repo);
        if (this.mode === 'local') {
            // getBranches reads HEAD and sorts it first in the same Git query.
            const branches = refs.filter(ref => !ref.remote);
            return [{ kind: 'local', repo, count: branches.length }, ...branchRows(repo, branches, '', this.localTreeLayout)];
        }
        const remotes = groupRemotes(repo, refs.filter(ref => ref.remote));
        return [
            { kind: 'remote', repo, count: remotes.length },
            ...remotes.map((remote): TreeNode => ({ kind: 'server', repo, remote })),
        ];
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        const root = node.repo.rootUri.toString();
        if (node.kind === 'repo') {
            const item = new vscode.TreeItem(basename(node.repo.rootUri.fsPath), Expanded);
            item.id = JSON.stringify([root]);
            item.tooltip = node.repo.rootUri.fsPath;
            item.iconPath = new vscode.ThemeIcon('repo');
            return item;
        }
        if (node.kind === 'local' || node.kind === 'remote') {
            const local = node.kind === 'local';
            const title = local ? t('Branches') : t('Remotes');
            const item = new vscode.TreeItem(title, None);
            item.id = JSON.stringify([root, 'summary', node.kind]);
            item.description = '(' + node.count + ')';
            item.accessibilityInformation = { label: title + ' ' + item.description };
            item.contextValue = local ? (this.localTreeLayout ? 'pilotLocalTree' : 'pilotLocalList') : 'pilotRemote';
            return item;
        }
        if (node.kind === 'server') {
            const item = new vscode.TreeItem(node.remote.name, node.remote.branches.length ? Collapsed : None);
            item.id = JSON.stringify([root, 'remoteGroup', node.remote.name]);
            item.description = '(' + node.remote.branches.length + ')';
            item.iconPath = new vscode.ThemeIcon('cloud');
            item.tooltip = t('Remote branches from the last fetch. Use Git: Fetch to update them.');
            item.accessibilityInformation = { label: node.remote.name + ' ' + item.description };
            return item;
        }
        if (node.kind === 'folder') {
            const item = new vscode.TreeItem(node.label, Collapsed);
            item.id = JSON.stringify([root, 'folder', this.mode, node.prefix]);
            item.iconPath = new vscode.ThemeIcon('folder');
            return item;
        }
        const { branch } = node;
        const item = new vscode.TreeItem(node.label);
        item.id = JSON.stringify([root, branch.ref]);
        if (branch.current) {
            item.label = { label: node.label, highlights: [[0, node.label.length]] };
            item.iconPath = new vscode.ThemeIcon('smart-git-pilot-current-branch', new vscode.ThemeColor('smartGitPilot.currentBranchForeground'));
        } else {
            item.iconPath = new vscode.ThemeIcon('git-branch');
        }
        const details = [formatRelativeTime(branch.date)];
        if (branch.upstream) {
            details.unshift('⇄ ' + branch.upstream.replace(/^refs\/(heads|remotes)\//, ''));
        }
        if (branch.current) {
            details.unshift(t('Current'));
        }
        item.description = details.join('  •  ');
        item.tooltip = [branch.current ? t('Current branch: {0}', branch.name) : branch.name, item.description].join('\n');
        item.contextValue = branch.current ? 'pilotCurrentBranch' : 'pilotBranch';
        item.command = { command: BRANCH_VIEW + '.actions', title: t('Branch Actions'), arguments: [node] };
        return item;
    }
}
