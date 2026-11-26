import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { BranchTree } from '../modules/git/BranchTree';
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
                assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
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
            assert.ok(branches.every(n => tree.getTreeItem(n).collapsibleState === vscode.TreeItemCollapsibleState.None));
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
