import * as vscode from 'vscode';
import { basename, posix } from 'node:path';
import { BranchRef, GitService, HistoryCommit } from './GitService';
import { authorAvatar } from './authorAvatar';
import { commitHover } from './commitHover';
import { CommitFileNode, CommitFolderNode, commitFileRows, commitFileUri } from './CommitFiles';
import { Repository } from './typings/git';
import { formatRelativeTime } from './formatRelativeTime';

export const BRANCH_VIEW = 'smart-commit-pilot.branches';
export const EMPTY_FILE_SCHEME = 'smart-git-pilot-empty';
const HISTORY_PAGE_SIZE = 30;
export type BranchMode = 'local' | 'remote';
export type BranchNode = { kind: 'branch'; repo: Repository; branch: BranchRef; label: string };
type RemoteGroup = { name: string; branches: BranchRef[] };
type CommitNode = { kind: 'commit'; repo: Repository; ref: string; commit: HistoryCommit };
export type TreeNode = BranchNode
    | CommitNode | CommitFileNode | CommitFolderNode
    | { kind: 'more'; repo: Repository; ref: string; nextLimit: number }
    | { kind: 'emptyCommit'; repo: Repository }
    | { kind: 'repo'; repo: Repository }
    | { kind: 'local'; repo: Repository; count: number }
    | { kind: 'remote'; repo: Repository; count: number }
    | { kind: 'server'; repo: Repository; remote: RemoteGroup }
    | { kind: 'folder'; repo: Repository; prefix: string; label: string; branches: BranchRef[] };

const t = vscode.l10n.t;
const { Expanded, Collapsed, None } = vscode.TreeItemCollapsibleState;

function avatarsEnabled(repo: Repository): boolean {
    return vscode.workspace.getConfiguration('smartCommitPilot', repo.rootUri).get('blame.avatars', true);
}

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
    private readonly historyLimits = new Map<string, number>();
    private canInspectCommit?: Thenable<boolean>;
    readonly onDidChangeTreeData = this.changes.event;

    constructor(private readonly git: GitService, public mode: BranchMode,
        public localTreeLayout: boolean) {}

    refresh(): void {
        this.changes.fire();
    }

    dispose(): void {
        this.changes.dispose();
    }

    showMore(node: Extract<TreeNode, { kind: 'more' }>): void {
        this.historyLimits.set(JSON.stringify([node.repo.rootUri.toString(), node.ref]), node.nextLimit);
        this.refresh();
    }

    private async commitRows(node: BranchNode): Promise<TreeNode[]> {
        const { repo, branch } = node;
        const ref = branch.ref;
        const limit = this.historyLimits.get(JSON.stringify([repo.rootUri.toString(), ref])) ?? HISTORY_PAGE_SIZE;
        const commits = await this.git.getBranchHistory(repo, ref, limit + 1);
        const rows: TreeNode[] = commits.slice(0, limit).map(commit => ({ kind: 'commit', repo, ref, commit }));
        if (commits.length > limit) {
            rows.push({ kind: 'more', repo, ref, nextLimit: limit + HISTORY_PAGE_SIZE });
        }
        return rows;
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        switch (node?.kind) {
            case 'local':
            case 'remote':
            case 'file':
            case 'more':
            case 'emptyCommit': return [];
            case 'branch': return this.commitRows(node);
            case 'commit': {
                const files = await this.git.getCommitFiles(node.repo, node.commit);
                return files.length ? commitFileRows(node, files) : [{ kind: 'emptyCommit', repo: node.repo }];
            }
            case 'commitFolder': return commitFileRows(node, node.files, node.prefix);
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
        if (node.kind === 'commit') {
            const { hash, subject, author, date } = node.commit;
            const item = new vscode.TreeItem(subject || t('Untitled commit'), Collapsed);
            item.id = JSON.stringify([root, node.ref, hash]);
            const avatar = avatarsEnabled(node.repo) ? authorAvatar(node.commit.authorEmail, 32) : undefined;
            item.iconPath = avatar ?? new vscode.ThemeIcon('account');
            item.description = [author, formatRelativeTime(date)].filter(Boolean).join(' · ');
            return item;
        }
        if (node.kind === 'commitFolder') {
            const item = new vscode.TreeItem(node.label, Expanded);
            item.id = JSON.stringify([root, node.ref, node.commit.hash, 'folder', node.prefix]);
            item.iconPath = vscode.ThemeIcon.Folder;
            item.resourceUri = vscode.Uri.joinPath(node.repo.rootUri, node.prefix.slice(0, -1)).with({ scheme: 'smart-git-pilot-folder' });
            item.tooltip = node.prefix;
            return item;
        }
        if (node.kind === 'more') {
            const item = new vscode.TreeItem(t('Show more commits…'));
            item.id = JSON.stringify([root, node.ref, 'more']);
            item.iconPath = new vscode.ThemeIcon('ellipsis');
            item.command = { command: BRANCH_VIEW + '.more', title: t('Show more commits…'), arguments: [node] };
            return item;
        }
        if (node.kind === 'emptyCommit') {
            return new vscode.TreeItem(t('No file changes'));
        }
        if (node.kind === 'file') {
            return this.fileItem(node);
        }
        const { branch } = node;
        const item = new vscode.TreeItem(node.label, Collapsed);
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
        return item;
    }

    async resolveTreeItem(item: vscode.TreeItem, node: TreeNode, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
        if (node.kind !== 'commit' || item.tooltip !== undefined || token.isCancellationRequested) {
            return item;
        }
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort());
        this.canInspectCommit ??= vscode.commands.getCommands(true).then(ids => ids.includes('git.viewCommit'));
        try {
            // The row's saved summary can still be displayed if its Git object disappears.
            const [details, canInspect] = await Promise.all([
                this.git.getCommitHoverDetails(node.repo, node.commit, controller.signal).catch(() => undefined),
                this.canInspectCommit,
            ]);
            if (!token.isCancellationRequested) {
                item.tooltip = commitHover(node.repo.rootUri, node.commit, details, avatarsEnabled(node.repo), canInspect);
            }
        } finally {
            cancel.dispose();
            controller.abort();
        }
        return item;
    }

    private fileItem({ repo, ref, commit, file, directory }: CommitFileNode): vscode.TreeItem {
        const uri = vscode.Uri.joinPath(repo.rootUri, file.path);
        const original = vscode.Uri.joinPath(repo.rootUri, file.previousPath);
        const empty = uri.with({ scheme: EMPTY_FILE_SCHEME });
        const left = commit.parent && file.status !== 'A' ? this.git.api.toGitUri(original, commit.parent) : empty;
        const right = file.status === 'D' ? empty : this.git.api.toGitUri(uri, commit.hash);
        const item = new vscode.TreeItem(posix.basename(file.path));
        item.id = JSON.stringify([repo.rootUri.toString(), ref, commit.hash, file.path]);
        item.resourceUri = commitFileUri(uri, commit.hash, file.status);
        item.iconPath = vscode.ThemeIcon.File;
        item.description = directory || undefined;
        item.tooltip = file.previousPath === file.path ? file.path : file.previousPath + ' → ' + file.path;
        item.accessibilityInformation = { label: file.path + ', ' + file.status };
        const title = file.path + ' (' + (commit.parent?.slice(0, 7) ?? '∅') + ' ↔ ' + commit.hash.slice(0, 7) + ')';
        item.command = { command: 'vscode.diff', title, arguments: [left, right, title, { preview: true }] };
        return item;
    }
}
