import * as assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComposerGit, Scope, withScratch } from '../modules/composer/git';
import { collectChanges } from '../modules/composer/changes';
import { buildPlan, parseGroups } from '../modules/composer/plan';
import { draftSource, mergeUnlocked, moveEdits, reorder } from '../modules/composer/curation';
import { chooseDepth, plannerRequest, planGroups } from '../modules/composer/planner';
import { SequenceValidator } from '../modules/composer/validation';
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
        assert.equal(plannerRequest({ model: 'gpt-6.1-sol', files, convention: 'Use Chinese.', guidance: '' }, false, 'Group').avoidCacheWrites, true);
        for (const edits of [[1],[1,1,2],[1,2,3],['1-999999999'],[0],[]]) {
            assert.throws(() => parseGroups(JSON.stringify({ commits: [{ message: 'x', edits }] }), files));
        }
        assert.deepEqual(parseGroups('{"commits":[{"message":"x","edits":["1-2"]}]}', files)[0].edits, [1,2]);
    });

    test('Reorders and moves only the selected draft’s share of a file, including into a new draft', async () => {
        await stagePair();
        const extra = ['guide.md', 'widget.ts'];
        for (const path of extra) { await writeFile(join(root, path), path); }
        const { snapshot, files } = await source('working');
        const ids = (path: string) => files.find(f => f.after.path === path)!.edits.map(e => e.id);
        const [retry, panel] = ids(filename);
        const plan = await buildPlan(git, snapshot, files, [
            { message: 'Keep my message', edits: [retry, ...ids(extra[0])] },
            { message: 'Enable panel', edits: [panel] }, { message: 'Show widget', edits: ids(extra[1]) },
        ]);
        const split = moveEdits(plan, 0, plan.drafts[0].files.find(f => f.path === filename)!.ids, 'new');
        assert.equal(split.active, 1);
        let next = await buildPlan(git, snapshot, files, split.groups);
        assert.equal(next.drafts.length, 4);
        assert.equal(next.drafts[0].message, 'Keep my message');
        assert.deepEqual(next.drafts[1].edits, [retry]);
        assert.deepEqual(next.drafts[2].edits, [panel]);
        next = await buildPlan(git, snapshot, files, reorder(next, 2, 0));
        assert.match(next.drafts[0].files[0].patch, /\+const panel = true/);
        assert.doesNotMatch(next.drafts[0].files[0].patch, /\+const retries = 3/);
        const merge = moveEdits(next, 0, next.drafts[0].files[0].ids, 3);
        assert.equal(merge.active, 2);
        const merged = await buildPlan(git, snapshot, files, merge.groups);
        assert.equal(merged.drafts.length, 3);
        assert.equal(merged.drafts.at(-1)?.tree, snapshot.target);
        assert.throws(() => moveEdits(merged, 0, [-1], 1));
        assert.throws(() => moveEdits(merged, 0, merged.drafts[0].files[0].ids, 'new'));
        assert.equal(await git.text(['rev-parse', 'HEAD']), snapshot.head);
    });

    test('Moves a block or an adjacent line pair from the only file and recalculates locations after earlier insertions', async () => {
        const gap = Array.from({length: 8}, (_, i) => 'context ' + i);
        const originalLines = ['header', 'first', 'second', ...gap, 'last'];
        const updated = ['new header', 'header', 'FIRST', 'SECOND', ...gap, 'LAST'];
        await writeFile(file(), originalLines.join('\r\n'));
        await git.run(['add', '--', filename]);
        await git.run(['commit', '-qm', 'Initial']);
        await writeFile(file(), updated.join('\r\n'));
        const { snapshot, files } = await source('working');
        const [header, first, second, last] = files[0].edits.map(e => e.id);
        let plan = await buildPlan(git, snapshot, files, [
            { message: 'Add header', edits: [header] }, { message: 'Keep this title', edits: [first, second, last] },
        ]);
        const [pair, tail] = plan.drafts[1].files[0].blocks!;
        assert.deepEqual(pair.units.map(unit => unit.id), [first, second]);
        assert.deepEqual([pair.oldStart, pair.newStart, pair.removed, pair.added], [2, 2, 2, 2]);
        assert.deepEqual(pair.units[0], { id: first, removed: ['first\r\n'], added: ['FIRST\r\n'] });
        assert.deepEqual(tail.units[0], { id: last, removed: ['last'], added: ['LAST'] });
        assert.throws(() => moveEdits(plan, 1, [header], 'new'));
        assert.throws(() => moveEdits(plan, 1, [first, first], 'new'));
        const blockMove = moveEdits(plan, 1, tail.units.map(unit => unit.id), 'new');
        plan = await buildPlan(git, snapshot, files, blockMove.groups);
        const lineMove = moveEdits(plan, 1, [first], 2);
        plan = await buildPlan(git, snapshot, files, lineMove.groups);
        assert.equal(plan.drafts[1].message, 'Keep this title');
        assert.deepEqual(plan.drafts[1].edits, [second]);
        assert.match(plan.drafts[1].files[0].patch, /\+SECOND/);
        assert.doesNotMatch(plan.drafts[1].files[0].patch, /\+FIRST|\+LAST/);
        assert.equal((await git.run(['show', plan.drafts[1].tree + ':' + filename])).toString(),
            ['new header', 'header', 'first', 'SECOND', ...gap, 'last'].join('\r\n'));
        assert.equal(plan.drafts[2].tree, snapshot.target);
        assert.equal(await git.text(['rev-parse','HEAD']), snapshot.head);
        assert.equal(await git.text(['write-tree']), snapshot.staged);
    });

    test('Tracks interleaved lines of a new file and keeps an indivisible binary change whole', async () => {
        await writeFile(file(), 'same\nsame\nlast');
        await writeFile(join(root, 'image.bin'), Buffer.from([0,12,255]));
        const { snapshot, files } = await source('working');
        const [one, two, three] = files.find(f => f.after.path === filename)!.edits.map(e => e.id);
        const binary = files.find(f => f.after.path === 'image.bin')!.edits[0].id;
        const plan = await buildPlan(git, snapshot, files, [
            { message: 'Keep middle line', edits: [two] }, { message: 'Add remaining changes', edits: [one, three, binary] },
        ]);
        const binaryFile = plan.drafts[1].files.find(f => f.path === 'image.bin')!;
        assert.deepEqual(binaryFile.ids, [binary]);
        assert.equal(binaryFile.blocks, undefined);
        const blocks = plan.drafts[1].files.find(f => f.path === filename)!.blocks!;
        assert.deepEqual(blocks.map(b => [b.oldStart, b.newStart, b.units[0].id]), [[0,0,one],[1,2,three]]);
        assert.equal(plan.drafts[1].tree, snapshot.target);
    });

    test('A targeted AI split uses only the selected IDs, including nonconsecutive IDs', async () => {
        for (const path of ['a','b','c','d']) { await writeFile(join(root, path), path); }
        const { files } = await source('working');
        const subset = draftSource(files, [2,4]);
        const parse = (ids: number[]) => parseGroups(JSON.stringify({ commits: ids.map(id =>
            ({ message: 'part ' + id, edits: [id] })) }), subset);
        assert.equal(parse([4,2]).length, 2);
        assert.throws(() => parse([2,3]));
        assert.throws(() => parse([2]));
        const draft = { message: 'Current subject', edits: [2,4] };
        const request = plannerRequest({ model: 'model', files: subset, convention: 'Use Chinese.', guidance: 'Separate the fixes', previous: [draft], split: true }, false, 'Split');
        const prefix = request.messages[0].content;
        assert.ok(Array.isArray(prefix));
        const input = { ...JSON.parse(prefix[0].text), ...JSON.parse(String(request.messages[1].content)) };
        assert.deepEqual(input.files.map((f: {path: string}) => f.path), ['b','d']);
        assert.equal(input.guidance, 'Separate the fixes');
        assert.deepEqual(input.previousDrafts, [draft]);
    });

    test('Locked boundaries preserve the reviewed patch even when both sides touch the same file', async () => {
        await writeFile(file(), 'one\ntwo\nthree\nfour\nfive');
        const { snapshot, files } = await source('working');
        const groups = [1,2,3,4,5].map(id => ({ message: 'Draft ' + id, edits: [id], locked: id === 3 }));
        const plan = await buildPlan(git, snapshot, files, groups);
        const revised = mergeUnlocked(groups, [{ message: 'Last', edits: [4,5] }, { message: 'First', edits: [1,2] }]);
        const next = await buildPlan(git, snapshot, files, revised);
        assert.deepEqual(next.drafts[1], plan.drafts[2]);
        assert.throws(() => mergeUnlocked(groups, [{ message: 'Both sides', edits: [2,4] }]));
        assert.throws(() => moveEdits(plan, 0, [1], 3));
        assert.throws(() => reorder(plan, 4, 0));
        assert.throws(() => moveEdits(plan, 2, [3], 3));
    });

    test('Keeps the diff prefix identical when a deep ordering response needs correction', async () => {
        for (const path of ['a','b']) { await writeFile(join(root, path), path); }
        const { files } = await source('working');
        assert.equal(chooseDepth(files, 'auto'), false);
        assert.equal(chooseDepth(files, 'deep'), true);
        const ctx = { files, model: 'model', convention: '', guidance: '' };
        const replies = [
            '{"concerns":[{"purpose":"purpose","paths":["a"],"dependsOn":[]}]}',
            '{"commits":[{"message":"A","edits":[1]},{"message":"B","edits":[2]}]}',
            '{"order":[2,2]}', '{"order":[2,1]}',
        ];
        const requests = [];
        const result = await planGroups(ctx, { deep: true, instructions: [] }, async req => {
            requests.push(req);
            assert.deepEqual(req.messages[0], plannerRequest(ctx, true, '').messages[0]);
            return replies.shift()!;
        }, () => {});
        assert.equal(requests.length, 4);
        assert.deepEqual(result.groups.map(g => g.message), ['B','A']);
    });

    test('Shows a broken intermediate manifest even when the complete tree is correct', async () => {
        await writeFile(join(root, 'package.json'), '{\n"private":true\n}\n');
        const { snapshot, files } = await source('working');
        const draft = await buildPlan(git, snapshot, files, [{ message: 'Incomplete', edits: [1] }, { message: 'Finish', edits: [2,3] }]);
        const checked = await new SequenceValidator(git, new AbortController().signal).verify(draft, () => {});
        assert.deepEqual(checked.drafts[0].check?.issues.map(i => i.file), ['package.json']);
        assert.deepEqual(checked.drafts[1].check?.issues, []);
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
