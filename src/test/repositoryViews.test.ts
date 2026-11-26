import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { BranchTree } from '../modules/git/BranchTree';
import { GitService } from '../modules/git/GitService';
import { Repository } from '../modules/git/typings/git';

suite('Repository views', function () {
    this.timeout(30000);
    let dir: string;
    let service: GitService;
    let repo: Repository;
    const name = 'A. [Dev]';
    const email = 'dev+x@example.invalid';
    const git = (...args: string[]) => execFileSync(service.api.git.path, ['-c', 'commit.gpgSign=false',
        '-c', 'tag.gpgSign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();

    suiteSetup(async () => {
        await vscode.extensions.getExtension('michael-yu.smart-commit-pilot')!.activate();
        service = new GitService();
        dir = await realpath(await mkdtemp(join(tmpdir(), 'pilot-repo-views-')));
        git('init', '-q');
        git('symbolic-ref', 'HEAD', 'refs/heads/main');
        git('config', 'user.name', name);
        git('config', 'user.email', email);
        await writeFile(join(dir, '.mailmap'), name + ' <' + email + '> Alias <old@example.invalid>\n');
        git('add', '.mailmap');
        git('commit', '-qm', 'Initial');
        const opened = await service.api.openRepository(vscode.Uri.file(dir));
        assert.ok(opened);
        repo = opened;
    });
    suiteTeardown(async () => { if (dir) { await rm(dir, { recursive: true, force: true }); } });

    test('Tags appear in one flat list with full names and expandable commit history', async () => {
        const tree = new BranchTree(service, 'tags', true);
        try {
            const rows = () => tree.getChildren({ kind: 'repo', repo });
            assert.equal((await rows())[1].kind, 'emptyView');
            git('tag', 'release/one');
            git('tag', '-a', 'release/two', '-m', 'Milestone');
            git('-c', 'advice.nestedTag=false', 'tag', '-a', 'nested', '-m', 'Nested milestone', 'release/two');
            git('tag', 'file', 'HEAD:.mailmap');
            const roots = await rows();
            assert.equal(tree.getTreeItem(roots[0]).description, '(4)');
            assert.equal(tree.getTreeItem(roots[0]).collapsibleState, vscode.TreeItemCollapsibleState.None);
            assert.deepEqual(roots.slice(1).map(row => tree.getTreeItem(row).label).sort(),
                ['file', 'nested', 'release/one', 'release/two']);
            const annotated = roots.find(n => n.kind === 'tag' && n.tag.name === 'release/two');
            assert.ok(annotated);
            assert.ok(String(tree.getTreeItem(annotated).tooltip).includes('Milestone'));
            const nested = roots.find(n => n.kind === 'tag' && n.tag.name === 'nested');
            assert.ok(nested?.kind === 'tag' && nested.tag.hash === git('rev-parse', 'HEAD'));
            const [commit] = await tree.getChildren(nested);
            assert.equal(commit.kind, 'commit');
            assert.equal((await tree.getChildren(commit))[0].kind, 'file');
            const blob = roots.find(n => n.kind === 'tag' && n.tag.name === 'file');
            assert.ok(blob);
            assert.equal(tree.getTreeItem(blob).collapsibleState, vscode.TreeItemCollapsibleState.None);
            git('tag', '-d', 'release/one');
            tree.refresh();
            assert.equal(tree.getTreeItem((await rows())[0]).description, '(3)');
        } finally {
            tree.dispose();
        }
    });

    test('Contributor counts and paged history use the same branch scope and exact mailmapped identity', async () => {
        git('switch', '-qc', 'side');
        git('commit', '--allow-empty', '-qm', 'Side only', '--author=Side <side@example.invalid>');
        git('switch', '-q', 'main');
        git('commit', '--allow-empty', '-qm', 'Similar name', '--author=Not ' + name + ' <' + email + '>');
        for (let n = 0; n < 30; n++) {
            git('commit', '--allow-empty', '-qm', 'Alias ' + n, '--author=Alias <old@example.invalid>');
        }
        const tree = new BranchTree(service, 'contributors', false);
        const rows = () => tree.getChildren({ kind: 'repo', repo });
        try {
            const [header, self, other] = await rows();
            assert.equal(header.kind, 'contributors');
            assert.equal(header.count, 2);
            assert.equal(self.kind, 'contributor');
            assert.equal(self.author.count, 31);
            assert.equal(self.author.current, true);
            assert.equal(other.kind, 'contributor');
            assert.equal(other.author.count, 1);
            const history = await tree.getChildren(self);
            const more = history.at(-1);
            assert.ok(more?.kind === 'more');
            tree.showMore(more);
            const expanded = await tree.getChildren(self);
            assert.equal(expanded.length, 31);
            assert.ok(expanded.every(n => n.kind === 'commit' && n.commit.author === name));
            tree.allContributors = true;
            const side = (await rows()).find(n => n.kind === 'contributor' && n.author.name === 'Side');
            assert.ok(side?.kind === 'contributor');
            const [commit] = await tree.getChildren(side);
            assert.ok(commit.kind === 'commit' && commit.commit.subject === 'Side only');
            git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
            tree.allContributors = false;
            const merged = (await rows()).filter(n => n.kind === 'contributor');
            assert.equal(merged.reduce((count, row) => count + row.author.count, 0), 33);
            git('switch', '--orphan', 'empty');
            assert.equal((await rows())[1].kind, 'emptyView');
        } finally {
            tree.dispose();
        }
    });
});
