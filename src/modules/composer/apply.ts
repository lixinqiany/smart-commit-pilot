import { randomUUID } from 'node:crypto';
import { access, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { l10n } from 'vscode';
import { ComposerGit, withScratch } from './git';
import { Plan } from './plan';

async function assertIdle(git: ComposerGit): Promise<void> {
    const directory = resolve(git.root, await git.text(['rev-parse', '--absolute-git-dir']));
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_LOG']) {
        try { await access(join(directory, name)); }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
            throw err;
        }
        throw new Error(l10n.t('Finish the current Git operation before creating split commits.'));
    }
}

async function verify(git: ComposerGit, plan: Plan, index: string): Promise<void> {
    await assertIdle(git);
    const expected = plan.snapshot;
    const actual = await git.capture(expected.scope, index);
    if (actual.head !== expected.head || actual.ref !== expected.ref || actual.staged !== expected.staged ||
        actual.target !== expected.target) {
        throw new Error(l10n.t('The branch or selected changes have changed. Generate a fresh preview.'));
    }
}

async function publish(git: ComposerGit, plan: Plan, tip: string, finalIndex: string): Promise<void> {
    const { head, ref, scope } = plan.snapshot;
    const index = await git.indexPath();
    const lockPath = index + '.lock';
    // Hold Git's usual index lock across the final check and ref transaction.
    const lock = await open(lockPath, 'wx');
    let promoted = false;
    try {
        await verify(git, plan, finalIndex);
        if (scope === 'working') { await lock.writeFile(await readFile(finalIndex)); }
        await lock.close();
        await git.run(['update-ref', '-m', 'Smart Git Pilot: split commits', ref, tip, head || '0'.repeat(tip.length)]);
        if (scope === 'working') {
            try { await rename(lockPath, index); }
            catch (err) {
                if (head) { await git.run(['update-ref', ref, head, tip]); }
                else { await git.run(['update-ref', '-d', ref, tip]); }
                throw err;
            }
            promoted = true;
        }
    } finally {
        await lock.close();
        if (!promoted) { await rm(lockPath, { force: true }); }
    }
}

// Prepare the entire chain with ordinary Git commits (including signing and hooks).
// The user's branch advances once, after every commit matches its reviewed tree.
export async function applyPlan(git: ComposerGit, plan: Plan, sign: boolean): Promise<void> {
    if (!plan.drafts.length || plan.drafts.at(-1)!.tree !== plan.snapshot.target ||
        plan.drafts.some(d => !d.message.trim() || d.message.includes('\0'))) {
        throw new Error(l10n.t('Each draft needs a valid commit message.'));
    }
    await withScratch(async dir => {
        await verify(git, plan, join(dir, 'check'));
        const { head, base } = plan.snapshot;
        const workdir = join(dir, 'commits');
        const work = new ComposerGit(workdir, git.executable);
        const scratchRef = 'refs/smart-git-pilot/' + randomUUID();
        const hooks = resolve(git.root, await git.text(['rev-parse', '--git-path', 'hooks']));
        const anchor = head || await git.text(['commit-tree', base, '-m', 'Temporary split preview base']);
        await git.run(['worktree', 'add', '--detach', '--no-checkout', workdir, anchor]);
        try {
            if (!head) { await work.run(['symbolic-ref', 'HEAD', scratchRef]); }
            let parent = head;
            for (const draft of plan.drafts) {
                await work.run(['read-tree', '--reset', '-u', draft.tree]);
                const signing = sign ? ['-S'] : [];
                await work.run(['-c', 'core.hooksPath=' + hooks, 'commit', ...signing, '--cleanup=verbatim', '-F', '-'], draft.message.trim() + '\n');
                const tree = await work.text(['rev-parse', 'HEAD^{tree}']);
                const message = await work.text(['log', '-1', '--format=%B']);
                const [commit, ...parents] = (await work.text(['rev-list', '-1', '--parents', 'HEAD'])).split(' ');
                if (tree !== draft.tree || message !== draft.message.trim() || parents.join(' ') !== parent) {
                    throw new Error(l10n.t('A Git hook changed a reviewed commit. The split was stopped.'));
                }
                parent = commit;
            }
            await publish(git, plan, parent, join(dir, 'publish'));
        } finally {
            try { await git.run(['worktree', 'remove', '--force', workdir]); }
            finally { if (!head) { await git.run(['update-ref', '-d', scratchRef]); } }
        }
    });
}
