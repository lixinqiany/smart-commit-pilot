import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { BranchTree } from '../modules/git/BranchTree';
import { deletionItems } from '../modules/git/branchDeletionPicker';
import { authorAvatar } from '../modules/git/authorAvatar';
import { commitHover } from '../modules/git/commitHover';
import { commitFileDecorations, commitFileRows } from '../modules/git/CommitFiles';
import { GitService } from '../modules/git/GitService';
import { Repository } from '../modules/git/typings/git';

suite('Branch panel', function () {
    this.timeout(20000);
    let dir: string;
    let service: GitService;
    let repo: Repository;
    const git = (...args: string[]) => execFileSync(service.api.git.path, [
        '-c', 'user.name=Pilot', '-c', 'user.email=pilot@example.invalid',
        '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: dir, encoding: 'utf8' }).trim();

    suiteSetup(async () => {
        await vscode.extensions.getExtension('michael-yu.smart-commit-pilot')!.activate();
        service = new GitService();
        dir = await realpath(await mkdtemp(join(tmpdir(), 'pilot-branch-test-')));
        git('init', '-q');
        git('symbolic-ref', 'HEAD', 'refs/heads/main');
        await writeFile(join(dir, 'notes'), 'start\n');
        git('add', 'notes');
        git('commit', '-qm', 'Base');
        git('remote', 'add', 'origin', dir);
        git('update-ref', 'refs/remotes/origin/topic/ui', 'HEAD');
        git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic/ui');
        git('branch', 'topic/ui');
        const opened = await service.api.openRepository(vscode.Uri.file(dir));
        assert.ok(opened);
        repo = opened;
    });

    suiteTeardown(async () => {
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('Lists current, local and remote refs separately and excludes symbolic refs', async () => {
        const branches = await service.getBranches(repo);
        assert.equal(branches[0].name, 'main');
        assert.equal(branches[0].current, true);
        assert.ok(branches[0].date.getTime() > 0);
        assert.deepEqual(branches.filter(b => b.remote).map(b => b.name), ['origin/topic/ui']);
        assert.ok(branches.some(b => !b.remote && b.name === 'topic/ui'));
    });

    test('Local toolbar stays flat and the persistent highlight follows checkout', async () => {
        git('branch', 'topic/api');
        const tree = new BranchTree(service, 'local', false);
        const rows = () => tree.getChildren({ kind: 'repo', repo });
        const checkRows = async (expected: string[], current?: string) => {
            const [header, ...branches] = await rows();
            assert.equal(header.kind, 'local');
            const toolbar = tree.getTreeItem(header);
            assert.equal(toolbar.description, '(3)');
            assert.equal(toolbar.collapsibleState, vscode.TreeItemCollapsibleState.None);
            assert.deepEqual(await tree.getChildren(header), []);
            assert.deepEqual(branches.map(n => n.kind === 'branch' && n.branch.name), expected);
            for (const node of branches) {
                assert.equal(node.kind, 'branch');
                const item = tree.getTreeItem(node);
                assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
                assert.equal(item.command, undefined);
                assert.ok(item.iconPath instanceof vscode.ThemeIcon);
                if (node.branch.name === current) {
                    assert.equal(item.iconPath.id, 'smart-git-pilot-current-branch');
                    assert.deepEqual(item.iconPath.color, new vscode.ThemeColor('smartGitPilot.currentBranchForeground'));
                    assert.deepEqual(item.label, { label: current, highlights: [[0, current.length]] });
                    assert.ok(String(item.description).startsWith(vscode.l10n.t('Current')));
                } else {
                    assert.equal(item.label, node.label);
                    assert.equal(item.iconPath.id, 'git-branch');
                }
            }
        };
        try {
            await checkRows(['main', 'topic/api', 'topic/ui'], 'main');
            const target = (await rows()).find(n => n.kind === 'branch' && n.branch.name === 'topic/ui');
            assert.ok(target);
            await vscode.commands.executeCommand('smart-commit-pilot.branches.switchTo', target);
            await checkRows(['topic/ui', 'main', 'topic/api'], 'topic/ui');
            git('switch', 'topic/api');
            await checkRows(['topic/api', 'main', 'topic/ui'], 'topic/api');
            git('switch', '--detach', 'HEAD');
            await checkRows(['main', 'topic/api', 'topic/ui']);
        } finally {
            git('switch', 'main');
            tree.dispose();
        }
    });

    test('Local tree compacts shared prefixes and pins a checked-out child by its full name', async () => {
        const names = ['feature/mobile/login', 'feature/mobile/pay', 'feature/mobile/profile'];
        names.forEach(name => git('branch', name));
        const tree = new BranchTree(service, 'local', true);
        const rows = () => tree.getChildren({ kind: 'repo', repo });
        try {
            const outline = await rows();
            assert.equal(tree.getTreeItem(outline[0]).contextValue, 'pilotLocalTree');
            assert.equal(tree.getTreeItem(outline[0]).collapsibleState, vscode.TreeItemCollapsibleState.None);
            const folder = outline.find(n => n.kind === 'folder' && n.label === 'feature/mobile');
            assert.ok(folder);
            assert.equal(tree.getTreeItem(folder).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
            const children = await tree.getChildren(folder);
            assert.deepEqual(children.map(n => tree.getTreeItem(n).label), ['login', 'pay', 'profile']);
            await vscode.commands.executeCommand('smart-commit-pilot.branches.switchTo', children[1]);
            const [header, current, ...rest] = await rows();
            assert.equal(current.kind, 'branch');
            assert.equal(current.branch.current, true);
            assert.equal(current.label, 'feature/mobile/pay');
            assert.equal(tree.getTreeItem(header).description, tree.getTreeItem(outline[0]).description);
            const remaining = rest.find(n => n.kind === 'folder' && n.label === 'feature/mobile');
            assert.ok(remaining);
            assert.deepEqual((await tree.getChildren(remaining)).map(n => tree.getTreeItem(n).label), ['login', 'profile']);
            tree.localTreeLayout = false;
            const [flatHeader, ...flat] = await rows();
            assert.equal(tree.getTreeItem(flatHeader).contextValue, 'pilotLocalList');
            assert.ok(flat.every(n => n.kind === 'branch' && n.label === n.branch.name));
            assert.equal(flat.length, Number(tree.getTreeItem(flatHeader).description?.toString().slice(1, -1)));
        } finally {
            git('switch', 'main');
            tree.dispose();
        }
    });

    test('Remotes sit below a fixed count row and expand to flat branch names regardless of local layout', async () => {
        await repo.addRemote('mirror', dir);
        git('update-ref', 'refs/remotes/origin/topic/api', 'HEAD');
        const tree = new BranchTree(service, 'remote', true);
        try {
            const [remotes, mirror, origin] = await tree.getChildren({ kind: 'repo', repo });
            assert.equal(remotes.kind, 'remote');
            const header = tree.getTreeItem(remotes);
            assert.equal(header.description, '(2)');
            assert.equal(header.collapsibleState, vscode.TreeItemCollapsibleState.None);
            assert.equal(header.contextValue, 'pilotRemote');
            assert.deepEqual(await tree.getChildren(remotes), []);
            assert.equal(tree.getTreeItem(mirror).label, 'mirror');
            assert.equal(tree.getTreeItem(mirror).collapsibleState, vscode.TreeItemCollapsibleState.None);
            assert.deepEqual(await tree.getChildren(mirror), []);
            const group = tree.getTreeItem(origin);
            assert.equal(group.label, 'origin');
            assert.ok(group.iconPath instanceof vscode.ThemeIcon && group.iconPath.id === 'cloud');
            assert.equal(group.description, '(2)');
            assert.equal(group.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
            const branches = await tree.getChildren(origin);
            assert.deepEqual(branches.map(n => n.kind === 'branch' && n.label), ['topic/api', 'topic/ui']);
            assert.ok(branches.every(n => tree.getTreeItem(n).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
        } finally {
            tree.dispose();
        }
    });

    test('Remote switching reuses a differently named tracking branch despite a local namesake', async () => {
        await service.createBranch(repo, 'my-topic', 'refs/remotes/origin/topic/ui', 'track');
        assert.equal(git('rev-parse', '--symbolic-full-name', '@{u}'), 'refs/remotes/origin/topic/ui');
        await service.switchBranch(repo, 'main');
        const branch = (await service.getBranches(repo)).find(b => b.ref === 'refs/remotes/origin/topic/ui')!;
        await vscode.commands.executeCommand('smart-commit-pilot.branches.switchTo', { kind: 'branch', repo, branch });
        assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'my-topic');
    });

    test('Unopened local and remote branches expose their own history and read-only revision diffs', async () => {
        const tree = new BranchTree(service, 'local', false);
        const filename = '中文 #1.txt';
        const root = git('rev-parse', 'main');
        git('switch', '-c', 'history-demo', 'main');
        try {
            git('mv', 'notes', filename);
            git('commit', '-qm', 'Rename notes');
            const renamed = git('rev-parse', 'HEAD');
            git('update-ref', 'refs/remotes/origin/history-demo', renamed);
            await writeFile(join(dir, filename), 'second version\n');
            git('commit', '-qam', 'Edit notes');
            git('rm', filename);
            git('commit', '-qm', 'Delete notes');
            git('commit', '--allow-empty', '-qm', 'Empty commit');
            git('switch', 'main');

            const rows = () => tree.getChildren({ kind: 'repo', repo });
            const local = (await rows()).find(n => n.kind === 'branch' && n.label === 'history-demo');
            assert.ok(local);
            const history = await tree.getChildren(local);
            assert.deepEqual(history.map(n => tree.getTreeItem(n).label),
                ['Empty commit', 'Delete notes', 'Edit notes', 'Rename notes', 'Base']);
            assert.equal(tree.getTreeItem(history[1]).command, undefined);
            assert.equal((await tree.getChildren(history[0]))[0].kind, 'emptyCommit');
            const diff = async (commitIndex: number, status: string, before: string, after: string) => {
                const [file] = await tree.getChildren(history[commitIndex]);
                assert.equal(file.kind, 'file');
                assert.equal(file.file.status, status);
                const command = tree.getTreeItem(file).command!;
                assert.equal(command.command, 'vscode.diff');
                const [left, right] = command.arguments as [vscode.Uri, vscode.Uri];
                assert.equal((await vscode.workspace.openTextDocument(left)).getText(), before);
                assert.equal((await vscode.workspace.openTextDocument(right)).getText(), after);
                return { file, command, left, right };
            };
            await diff(4, 'A', '', 'start\n');
            const rename = await diff(3, 'R', 'start\n', 'start\n');
            assert.equal(rename.file.file.previousPath, 'notes');
            assert.equal(rename.file.file.path, filename);
            const edit = await diff(2, 'M', 'start\n', 'second version\n');
            await vscode.commands.executeCommand(edit.command.command, ...edit.command.arguments!);
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(tab instanceof vscode.TabInputTextDiff);
            assert.equal(tab.original.toString(), edit.left.toString());
            assert.equal(tab.modified.toString(), edit.right.toString());
            await diff(1, 'D', 'second version\n', '');

            tree.mode = 'remote';
            const origin = (await rows()).find(n => n.kind === 'server' && n.remote.name === 'origin');
            assert.ok(origin);
            const remote = (await tree.getChildren(origin)).find(n => n.kind === 'branch' && n.label === 'history-demo');
            assert.ok(remote);
            const remoteHistory = await tree.getChildren(remote);
            assert.deepEqual(remoteHistory.map(n => tree.getTreeItem(n).label), ['Rename notes', 'Base']);
            assert.notEqual(tree.getTreeItem(remoteHistory[0]).id, tree.getTreeItem(history[3]).id);
            assert.equal(git('rev-parse', 'HEAD'), root);
        } finally {
            git('switch', 'main');
            tree.dispose();
        }
    });

    test('Older commits load on demand and a merge shows changes against its first parent', async () => {
        const tree = new BranchTree(service, 'local', false);
        const base = git('rev-parse', 'main');
        const treeId = git('rev-parse', 'main^{tree}');
        let tip = base;
        for (let i = 1; i <= 31; i++) {
            tip = git('commit-tree', treeId, '-p', tip, '-m', 'Change ' + i);
        }
        const other = git('rev-parse', 'refs/remotes/origin/topic/ui');
        const emptyTree = git('mktree');
        const emptyParent = git('commit-tree', emptyTree, '-p', other, '-m', 'Remove notes');
        const merge = git('commit-tree', emptyTree, '-p', tip, '-p', emptyParent, '-m', 'Merge removal');
        git('update-ref', 'refs/heads/paged-history', merge);
        try {
            const branch = (await tree.getChildren({ kind: 'repo', repo })).find(n => n.kind === 'branch' && n.label === 'paged-history');
            assert.ok(branch);
            const initial = await tree.getChildren(branch);
            const more = initial[initial.length - 1];
            assert.equal(more.kind, 'more');
            assert.equal(initial.length, 31);
            const [file] = await tree.getChildren(initial[0]);
            assert.equal(file.kind, 'file');
            assert.equal(file.file.status, 'D');
            assert.equal(file.file.path, 'notes');
            tree.showMore(more);
            const all = await tree.getChildren(branch);
            assert.equal(all.length, 34);
            assert.equal(new Set(all.map(n => tree.getTreeItem(n).id)).size, 34);
            assert.ok(all.every(n => n.kind === 'commit'));
            assert.equal(all[all.length - 1].commit.hash, base);
        } finally {
            tree.dispose();
        }
    });

    test('Commit files group by directory, keep short relative paths, and decorate each revision independently', async () => {
        const [commit] = await service.getBranchHistory(repo, 'refs/heads/main', 1);
        const context = { repo, ref: 'refs/heads/main', commit };
        const tree = new BranchTree(service, 'local', false);
        try {
            const makeFile = (path: string, status = 'M') => ({ path, previousPath: path, status });
            const files = ['README.md', 'package.json', 'src/extension.ts', 'src/test/extension.test.ts',
                'src/modules/git/BlameRunner.ts', 'src/modules/git/GitService.ts', 'src/modules/git/typings/git.d.ts',
                'src/modules/configuration/Configurator.ts'].map(p => makeFile(p));
            const [src, ...rootFiles] = commitFileRows(context, files);
            assert.equal(src.kind, 'commitFolder');
            assert.equal(src.label, 'src');
            assert.equal(tree.getTreeItem(src).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
            assert.deepEqual(rootFiles.map(n => tree.getTreeItem(n).label), ['package.json', 'README.md']);
            const [modules, ...directFiles] = await tree.getChildren(src);
            assert.equal(modules.kind, 'commitFolder');
            assert.equal(modules.label, 'modules');
            assert.ok(directFiles.some(n => n.kind === 'file' && n.directory === 'test'));
            const nested = await tree.getChildren(modules);
            const typing = nested.find(n => n.kind === 'file' && n.file.path.endsWith('git.d.ts'));
            assert.ok(typing);
            const item = tree.getTreeItem(typing);
            assert.equal(item.label, 'git.d.ts');
            assert.equal(item.description, 'git/typings');
            const decorate = commitFileDecorations.provideFileDecoration;
            const status = decorate(item.resourceUri!);
            assert.equal(status?.badge, 'M');
            assert.deepEqual(status?.color, new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
            assert.equal(decorate(vscode.Uri.joinPath(repo.rootUri, 'git.d.ts')), undefined);
            const small = commitFileRows(context, files.slice(0, 5));
            assert.ok(small.every(n => n.kind === 'file'));
            const other = commitFileRows({ ...context, commit: { ...commit, hash: 'another-revision' } },
                [makeFile('src/modules/git/typings/git.d.ts', 'A')])[0];
            const otherUri = tree.getTreeItem(other).resourceUri!;
            assert.notEqual(otherUri.toString(), item.resourceUri!.toString());
            assert.equal(decorate(otherUri)?.badge, 'A');
            const [compact] = commitFileRows(context, files.map(f => makeFile('deep/path/' + f.path)));
            assert.equal(compact.kind, 'commitFolder');
            assert.equal(compact.label, 'deep/path');
            const icon = tree.getTreeItem({ ...context, kind: 'commit' }).iconPath;
            assert.ok(icon instanceof vscode.Uri && icon.authority === 'www.gravatar.com');
            assert.equal(icon.query, 's=32&d=robohash');
            const sameAuthor = tree.getTreeItem({ ...context, kind: 'commit', commit: { ...commit, subject: 'Other message' } }).iconPath;
            assert.equal(icon.toString(), sameAuthor?.toString());
            const otherAuthor = tree.getTreeItem({ ...context, kind: 'commit', commit: { ...commit, authorEmail: 'another@example.invalid' } }).iconPath;
            assert.notEqual(icon.toString(), otherAuthor?.toString());
        } finally {
            tree.dispose();
        }
    });

    test('Commit hovers show file status counts and line totals beside the hash without a refs footer', async () => {
        const tree = new BranchTree(service, 'local', false);
        const cancel = new vscode.CancellationTokenSource();
        git('switch', '-c', 'hover-demo', 'main');
        try {
            await writeFile(join(dir, 'existing'), 'before\n');
            await writeFile(join(dir, 'obsolete'), 'delete me\n');
            git('add', 'existing', 'obsolete');
            git('commit', '-qm', 'Prepare hover stats');
            git('mv', 'notes', 'renamed\tnotes');
            git('rm', 'obsolete');
            await writeFile(join(dir, 'existing'), 'before\nafter\n');
            await writeFile(join(dir, 'extra'), 'one\ntwo\n');
            git('add', 'existing', 'extra');
            git('commit', '-qm', 'Preview hover', '-m', '说明 <label>\n第二行 & details');
            git('tag', 'hover-test');
            git('switch', 'main');
            const [commit] = await service.getBranchHistory(repo, 'refs/heads/hover-demo', 1);
            const details = await service.getCommitHoverDetails(repo, commit, new AbortController().signal);
            assert.deepEqual(details.files, { added: 1, modified: 2, deleted: 1 });
            assert.equal(details.additions, 3);
            assert.equal(details.deletions, 1);
            assert.ok(details.message.includes('第二行 & details'));
            const node = { kind: 'commit' as const, repo, ref: 'refs/heads/hover-demo', commit };
            const item = tree.getTreeItem(node);
            assert.equal(item.tooltip, undefined);
            const resolved = await tree.resolveTreeItem(item, node, cancel.token);
            const card = resolved.tooltip;
            assert.ok(card instanceof vscode.MarkdownString);
            assert.ok(card.value.includes('s=64&d=robohash|width=32,height=32'));
            assert.ok(card.value.includes('command:smart-commit-pilot.copyBlameHash'));
            assert.ok(card.value.includes(commit.hash));
            assert.ok(card.value.includes('第二行'));
            assert.ok(card.value.includes('&lt;label&gt;'));
            assert.match(card.value, />\+1<.*>~2<.*>-1</);
            assert.ok(card.value.includes(vscode.l10n.t('{0} additions', 3)));
            assert.ok(card.value.includes(vscode.l10n.t('1 deletion')));
            assert.ok(!card.value.includes('hover-test') && !card.value.includes('$(git-branch)'));
            if ((await vscode.commands.getCommands(true)).includes('git.viewCommit')) {
                assert.ok(card.value.includes('command:git.viewCommit'));
                await vscode.commands.executeCommand('git.viewCommit', repo.rootUri, commit.hash);
                assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label.includes(commit.hash.slice(0, 7)))));
            }
            const basic = commitHover(repo.rootUri, commit, undefined, false, false);
            assert.ok(basic.value.includes('$(account)') && !basic.value.includes('https://'));
            assert.ok(!basic.value.includes('command:git.viewCommit'));
            cancel.cancel();
            assert.equal((await tree.resolveTreeItem(tree.getTreeItem(node), node, cancel.token)).tooltip, undefined);
            assert.equal(authorAvatar('123+dev@users.noreply.github.com', 32)?.toString(true),
                'https://avatars.githubusercontent.com/u/123?size=32');
            assert.equal(authorAvatar('dev@users.noreply.github.com', 32)?.authority, 'avatars.githubusercontent.com');
            assert.equal(authorAvatar('', 32), undefined);
            const [rootCommit] = await service.getBranchHistory(repo, 'refs/heads/main', 1);
            const rootDetails = await service.getCommitHoverDetails(repo, rootCommit, new AbortController().signal);
            assert.deepEqual(rootDetails.files, { added: 1, modified: 0, deleted: 0 });
            assert.deepEqual([rootDetails.additions, rootDetails.deletions], [1, 0]);
            const rootCard = commitHover(repo.rootUri, rootCommit, rootDetails, false, false);
            assert.match(rootCard.value, />\+1<.*>~0<.*>-0</);
            assert.equal(git('branch', '--show-current'), 'main');
        } finally {
            git('switch', 'main');
            cancel.dispose();
            tree.dispose();
        }
    });

    test('Fetch on local and remote rows updates only the mapped tracking ref', async () => {
        const remote = 'upstream/team';
        const target = 'refs/remotes/' + remote + '/view/row';
        const other = 'refs/remotes/' + remote + '/view/other';
        const base = git('rev-parse', 'main');
        const tip = git('commit-tree', 'main^{tree}', '-p', base, '-m', 'New remote tip');
        const tree = new BranchTree(service, 'local', false);
        await repo.addRemote(remote, dir);
        try {
            git('config', 'remote.' + remote + '.fetch', '+refs/heads/source/*:refs/remotes/' + remote + '/view/*');
            git('update-ref', 'refs/heads/source/row', tip);
            git('update-ref', 'refs/heads/source/other', tip);
            git('update-ref', target, base);
            git('update-ref', other, base);
            git('switch', 'main');
            git('branch', '--set-upstream-to=' + remote + '/view/row', 'main');
            const branches = await service.getBranches(repo);
            for (const ref of ['refs/heads/main', target]) {
                const branch = branches.find(b => b.ref === ref)!;
                const row = { kind: 'branch' as const, repo, branch, label: branch.name };
                assert.equal(tree.getTreeItem(row).contextValue, branch.current ? 'pilotCurrentBranchFetchable' : 'pilotBranchFetchable');
                git('update-ref', target, base);
                await vscode.commands.executeCommand('smart-commit-pilot.branches.fetch', row);
                assert.equal(git('rev-parse', target), tip);
                assert.equal(git('rev-parse', other), base);
                assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
                assert.equal(git('rev-parse', 'HEAD'), base);
            }
            const untracked = branches.find(b => b.name === 'source/row')!;
            assert.equal(tree.getTreeItem({ kind: 'branch', repo, branch: untracked, label: untracked.name }).contextValue, 'pilotBranch');
        } finally {
            tree.dispose();
            git('remote', 'remove', remote);
        }
    });

    test('Local deletion protects unmerged commits, changed tips, and checked-out worktrees', async () => {
        const localOnly = { force: false };
        const forced = { ...localOnly, force: true };
        const ref = 'refs/heads/delete/local';
        const base = git('rev-parse', 'main');
        const tip = git('commit-tree', 'main^{tree}', '-p', base, '-m', 'Unmerged local change');
        git('update-ref', ref, tip);
        const plan = await service.getBranchDeletion(repo, ref);
        assert.deepEqual(plan.targets, []);
        const items = deletionItems(plan, false);
        assert.equal(items[0].description, '-d');
        assert.equal(items[0].detail, vscode.l10n.t('No matching remote branch for {0} in the fetched refs.', 'delete/local'));
        assert.equal(items.at(-1)?.description, '--force');
        await assert.rejects(service.deleteLocalBranch(repo, plan, localOnly));
        assert.equal(git('rev-parse', ref), tip);
        git('update-ref', ref, base);
        await assert.rejects(service.deleteLocalBranch(repo, plan, forced));
        git('update-ref', ref, tip);
        const worktree = join(dir, 'linked-worktree');
        git('worktree', 'add', '-q', worktree, 'delete/local');
        try {
            await assert.rejects(service.deleteLocalBranch(repo, plan, forced));
            assert.equal(git('rev-parse', ref), tip);
        } finally {
            git('worktree', 'remove', worktree);
        }
        await service.deleteLocalBranch(repo, plan, forced);
        assert.equal(git('branch', '--list', 'delete/local'), '');
        await assert.rejects(service.getBranchDeletion(repo, 'refs/heads/main'));
        await assert.rejects(service.getBranchDeletion(repo, 'refs/remotes/origin/topic/ui'));
    });

    test('Combined deletion targets the configured server ref and protects against a stale or unmerged upstream', async () => {
        const bare = join(dir, '.git', 'delete-demo.git');
        const remote = 'delete/team';
        const localName = 'delete/local-name';
        const localRef = 'refs/heads/' + localName;
        const serverRef = 'refs/heads/release/server-name';
        const trackingRef = 'refs/remotes/' + remote + '/mapped/server-name';
        const base = git('rev-parse', 'main');
        const tip = git('commit-tree', 'main^{tree}', '-p', base, '-m', 'Remote only');
        git('init', '-q', '--bare', bare);
        await repo.addRemote(remote, bare);
        git('config', 'remote.' + remote + '.fetch', '+refs/heads/release/*:refs/remotes/' + remote + '/mapped/*');
        const track = () => git('branch', '--track', localName, remote + '/mapped/server-name');
        const readRemote = () => git('--git-dir=' + bare, 'for-each-ref', '--format=%(objectname)', serverRef);
        try {
            git('push', '-q', remote, base + ':' + serverRef, base + ':' + localRef);
            track();
            const plan = await service.getBranchDeletion(repo, localRef);
            assert.deepEqual(plan.targets, [{ remote, ref: serverRef, tip: base }]);
            await service.deleteLocalBranch(repo, plan, { force: false });
            assert.equal(readRemote(), base);
            assert.equal(git('branch', '--list', localName), '');

            track();
            const merged = await service.getBranchDeletion(repo, localRef);
            await service.deleteLocalBranch(repo, merged, { target: merged.targets[0], force: false });
            assert.equal(readRemote(), '');
            assert.equal(git('branch', '--list', localName), '');
            assert.equal(git('--git-dir=' + bare, 'rev-parse', localRef), base);

            git('push', '-q', remote, base + ':' + serverRef);
            track();
            const stale = await service.getBranchDeletion(repo, localRef);
            git('push', '-q', bare, tip + ':' + serverRef);
            await assert.rejects(service.deleteLocalBranch(repo, stale, { target: stale.targets[0], force: true }));
            assert.equal(readRemote(), tip);
            assert.equal(git('rev-parse', localRef), base);
            git('fetch', '-q', remote);
            assert.equal(git('rev-parse', trackingRef), tip);
            const unmerged = await service.getBranchDeletion(repo, localRef);
            await assert.rejects(service.deleteLocalBranch(repo, unmerged, { target: unmerged.targets[0], force: false }));
            assert.equal(readRemote(), tip);
            assert.equal(git('rev-parse', localRef), base);
            await service.deleteLocalBranch(repo, unmerged, { target: unmerged.targets[0], force: true });
            assert.equal(readRemote(), '');
            assert.equal(git('branch', '--list', localName), '');
        } finally {
            git('remote', 'remove', remote);
        }
    });

    test('An untracked branch offers each fetched namesake by its server name and deletes only the selected one', async () => {
        const name = 'review/menu';
        const ref = 'refs/heads/' + name;
        const base = git('rev-parse', 'main');
        const bare = join(dir, '.git', 'menu.git');
        git('init', '-q', '--bare', bare);
        await repo.addRemote('menu', bare);
        try {
            git('config', 'remote.menu.fetch', '+refs/heads/review/*:refs/remotes/menu/preview/*');
            git('branch', '--no-track', name, 'main');
            git('push', '-q', 'menu', base + ':' + ref);
            git('update-ref', 'refs/remotes/origin/' + name, base);
            const options = () => service.getBranchDeletion(repo, ref);
            const plan = await options();
            assert.deepEqual(plan.targets.map(t => t.remote).sort(), ['menu', 'origin']);
            const rows = deletionItems(plan, false);
            assert.equal(rows[0].target, undefined);
            const row = rows.find(i => i.description === 'menu/review/menu');
            assert.deepEqual(row?.target, { remote: 'menu', ref, tip: base });
            assert.equal(deletionItems(plan, true)[0].description, '-D');

            git('config', '--add', 'remote.menu.fetch', '^' + ref);
            assert.deepEqual((await options()).targets.map(t => t.remote), ['origin']);
            git('config', '--fixed-value', '--unset-all', 'remote.menu.fetch', '^' + ref);
            git('branch', '--set-upstream-to=menu/preview/menu', name);
            assert.deepEqual((await options()).targets.map(t => t.remote), ['menu']);
            git('update-ref', '-d', 'refs/remotes/menu/preview/menu');
            assert.deepEqual((await options()).targets, []);
            git('branch', '--unset-upstream', name);
            git('fetch', '-q', 'menu');
            assert.ok(row?.target);
            await service.deleteLocalBranch(repo, plan, { target: row.target, force: false });
            assert.equal(git('--git-dir=' + bare, 'for-each-ref', '--format=%(objectname)', ref), '');
            assert.equal(git('rev-parse', 'refs/remotes/origin/' + name), base);
            assert.equal(git('branch', '--list', name), '');
        } finally {
            git('remote', 'remove', 'menu');
        }
    });

    test('Create-only uses the selected base and a conflicting checkout preserves local edits', async () => {
        await service.switchBranch(repo, 'main');
        await service.createBranch(repo, 'new-base', 'refs/heads/main', 'switch');
        await writeFile(join(dir, 'notes'), 'changed on new-base\n');
        git('commit', '-qam', 'Change notes');
        await service.switchBranch(repo, 'main');
        await service.createBranch(repo, 'from-selected', 'refs/heads/new-base', 'create');
        assert.equal(git('rev-parse', 'from-selected'), git('rev-parse', 'new-base'));
        assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
        await writeFile(join(dir, 'notes'), 'local edits\n');
        await assert.rejects(service.switchBranch(repo, 'from-selected'));
        assert.equal(await readFile(join(dir, 'notes'), 'utf8'), 'local edits\n');
        assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
    });
});
