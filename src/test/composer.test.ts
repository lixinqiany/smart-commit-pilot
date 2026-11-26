import * as assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComposerGit, Scope, withScratch } from '../modules/composer/git';
import { collectChanges } from '../modules/composer/changes';
import { buildPlan, parseGroups, planningRequest } from '../modules/composer/plan';
import { applyPlan } from '../modules/composer/apply';

suite('Split commits', function () {
    this.timeout(30000);
    let root: string, git: ComposerGit;
    const filename = 'settings with spaces.ts';
    const original = 'const retries = 0;\r\nconst panel = false;';
    const target = 'const retries = 3;\r\nconst panel = true;';
    const file = () => join(root, filename);
    setup(async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), 'pilot-compose-test-')));
        git = new ComposerGit(root, 'git');
        await git.run(['init', '-q', '-b', 'main']);
        await git.run(['config', 'user.name', 'Split Test']);
        await git.run(['config', 'user.email', 'split@example.invalid']);
        await git.run(['config', 'commit.gpgSign', 'false']);
        await git.run(['config', 'core.autocrlf', 'false']);
        await git.run(['config', 'core.hooksPath', join(root, '.git', 'hooks')]);
    });
    teardown(async () => { await rm(root, { recursive: true, force: true }); });

    async function stagePair() {
        await writeFile(file(), original);
        await git.run(['add', '--', filename]);
        await git.run(['commit', '-qm', 'Initial']);
        await writeFile(file(), target);
        await git.run(['add', '--', filename]);
    }
    async function source(scope: Scope) {
        const snapshot = await withScratch(dir => git.capture(scope, join(dir, 'index')));
        return { snapshot, files: await collectChanges(git, snapshot) };
    }
    async function pair() {
        const { snapshot, files } = await source('staged');
        const groups = parseGroups(JSON.stringify({ commits: [
            { message: 'fix: enable retries', edits: [1] }, { message: 'feat: enable panel', edits: [2] },
        ] }), files);
        return buildPlan(git, snapshot, files, groups);
    }

    test('Previews adjacent replacements separately, then creates the exact reviewed chain and preserves unstaged edits', async () => {
        await stagePair();
        const before = await git.text(['rev-parse', 'HEAD']);
        const worktreeText = target + '\n// local WIP';
        await writeFile(file(), worktreeText);
        const plan = await pair();
        assert.equal(await git.text(['rev-parse', 'HEAD']), before);
        assert.equal((await git.run(['show', ':' + filename])).toString(), target);
        assert.match(plan.drafts[0].files[0].patch, /\+const retries = 3/);
        assert.doesNotMatch(plan.drafts[0].files[0].patch, /\+const panel = true/);
        assert.match(plan.drafts[1].files[0].patch, /\+const panel = true/);
        plan.drafts[0].message = 'fix: retry requests\n\nHandle temporary failures.';
        await applyPlan(git, plan, false);
        assert.equal(await git.text(['log', '-1', '--format=%B', 'HEAD^']), plan.drafts[0].message);
        assert.equal((await git.run(['show', 'HEAD^:' + filename])).toString(), original.replace('0','3'));
        assert.equal((await git.run(['show', 'HEAD:' + filename])).toString(), target);
        assert.equal(await readFile(file(), 'utf8'), worktreeText);
        assert.equal(await git.text(['diff', '--cached']), '');
    });

    test('Includes untracked files in working-tree scope and supports first commits on an unborn branch', async () => {
        await writeFile(file(), target);
        await writeFile(join(root,'image.bin'), Buffer.from([0,255,4]));
        const { snapshot, files } = await source('working');
        const groups = files.map(f => ({ message: 'add ' + f.after.path, edits: f.edits.map(e => e.id) }));
        const plan = await buildPlan(git, snapshot, files, groups);
        assert.equal(await git.text(['ls-files']), '');
        await applyPlan(git, plan, false);
        assert.equal(await git.text(['rev-list','--count','HEAD']), '2');
        assert.equal(await git.text(['status','--porcelain']), '');
        assert.deepEqual(await git.run(['show','HEAD:image.bin']), Buffer.from([0,255,4]));
        assert.equal(await git.text(['for-each-ref', 'refs/smart-git-pilot']), '');
    });

    test('Rejects omitted, duplicate and invented edit IDs and requests one-off caching', async () => {
        await stagePair();
        const { files } = await source('staged');
        assert.equal(files[0].edits.length, 2);
        assert.equal(planningRequest('gpt-6.1-sol', files, 'Use Chinese.', '').avoidCacheWrites, true);
        for (const edits of [[1],[1,1,2],[1,2,3],['1-999999999'],[0],[]]) {
            assert.throws(() => parseGroups(JSON.stringify({ commits: [{ message: 'x', edits }] }), files));
        }
        assert.deepEqual(parseGroups('{"commits":[{"message":"x","edits":["1-2"]}]}', files)[0].edits, [1,2]);
    });

    test('Working-tree scope reviews the disk version of partially staged files and preserves renames and modes', async () => {
        await stagePair();
        await writeFile(file(), target + '\n// unstaged on disk\n');
        await writeFile(join(root, 'runner'), '#!/bin/sh\nexit 0\n');
        await chmod(join(root, 'runner'), 0o755);
        const { snapshot, files } = await source('working');
        const plan = await buildPlan(git, snapshot, files, files.map(f => ({
            message: 'Update ' + f.after.path, edits: f.edits.map(edit => edit.id),
        })));
        assert.equal((await git.run(['show', ':' + filename])).toString(), target);
        await applyPlan(git, plan, false);
        assert.equal(await git.text(['status', '--porcelain']), '');
        assert.match(await git.text(['ls-tree', 'HEAD', 'runner']), /^100755 /);
        await git.run(['mv', 'runner', 'new runner']);
        const renamed = await source('staged');
        const renamedPlan = await buildPlan(git, renamed.snapshot, renamed.files, [{ message: 'Rename runner', edits: [1] }]);
        await applyPlan(git, renamedPlan, false);
        assert.match(await git.text(['ls-tree', 'HEAD', 'new runner']), /^100755 /);
        assert.equal(await git.text(['status', '--porcelain']), '');
    });

    test('Rejects stale previews, including switching to a branch at the same commit', async () => {
        await stagePair();
        const plan = await pair();
        await git.run(['switch','-c','other']);
        await assert.rejects(applyPlan(git, plan, false));
        await git.run(['switch','main']);
        await writeFile(file(), target + '\n');
        await git.run(['add','--',filename]);
        await assert.rejects(applyPlan(git, plan, false));
        assert.equal(await git.text(['rev-parse','HEAD']),plan.snapshot.head);
    });

    test('A failing second commit hook leaves the original branch, index and worktree intact', async () => {
        await stagePair();
        const plan = await pair();
        const hooks = join(root,'.private-hooks');
        await git.run(['config','core.hooksPath','.private-hooks']);
        await mkdir(hooks,{recursive:true});
        await writeFile(join(hooks,'commit-msg'), '#!/bin/sh\n! grep -q "enable panel" "$1"\n');
        await chmod(join(hooks,'commit-msg'),0o755);
        await assert.rejects(applyPlan(git,plan,false));
        assert.equal(await git.text(['rev-parse','HEAD']), plan.snapshot.head);
        assert.equal(await git.text(['write-tree']), plan.snapshot.staged);
        assert.equal(await readFile(file(),'utf8'),target);
        assert.equal((await git.text(['worktree','list','--porcelain'])).match(/^worktree /gm)?.length,1);
    });
});
