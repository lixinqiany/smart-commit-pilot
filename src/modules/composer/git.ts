import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { l10n } from 'vscode';

export type Scope = 'staged' | 'working';
export interface Snapshot {
    scope: Scope;
    ref: string;
    head: string;
    base: string;
    staged: string;
    target: string;
}

export class ComposerGit {
    constructor(readonly root: string, readonly executable: string) {}

    run(args: string[], input?: string | Buffer, index?: string): Promise<Buffer> {
        return new Promise((accept, reject) => {
            const env = { ...process.env };
            // Each call targets its own worktree, even when VS Code was launched
            // from a Git hook or a shell with an alternate index.
            for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_NAMESPACE']) {
                delete env[key];
            }
            const scratchConfig = index ? ['-c', 'core.hooksPath=' + devNull] : [];
            const child = execFile(this.executable, ['--no-pager', ...scratchConfig, ...args], {
                cwd: this.root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
                env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
                    ...(index ? { GIT_INDEX_FILE: index } : {}) },
            }, (err, stdout, stderr) => {
                if (err) { reject(new Error(stderr.toString().trim() || stdout.toString().trim() || err.message)); }
                else { accept(stdout); }
            });
            child.stdin?.on('error', () => { /* The exit callback reports the Git error. */ });
            child.stdin?.end(input);
        });
    }

    async text(args: string[], input?: string | Buffer, index?: string): Promise<string> {
        return (await this.run(args, input, index)).toString('utf8').trimEnd();
    }

    async indexPath(): Promise<string> {
        return resolve(this.root, await this.text(['rev-parse', '--git-path', 'index']));
    }

    async headState(): Promise<{ ref: string; head: string }> {
        const ref = await this.text(['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() =>
            this.text(['symbolic-ref', 'HEAD']));
        // Only an unborn symbolic branch may have no commit.
        const result = await this.text(['rev-parse', '--revs-only', '--verify', '--quiet', 'HEAD']).catch(async err => {
            if (ref.startsWith('refs/heads/') && !(await this.text(['for-each-ref', '--format=%(refname)', ref])).split('\n').includes(ref)) {
                return '';
            }
            throw err;
        });
        return { ref, head: result };
    }

    async capture(scope: Scope, index: string): Promise<Snapshot> {
        const state = await this.headState();
        const base = state.head ? await this.text(['rev-parse', state.head + '^{tree}'])
            : await this.text(['mktree'], '');
        try {
            await copyFile(await this.indexPath(), index);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
            await this.run(['read-tree', '--empty'], undefined, index);
        }
        if ((await this.run(['ls-files', '--unmerged', '-z'], undefined, index)).length) {
            throw new Error(l10n.t('Resolve merge conflicts before splitting commits.'));
        }
        const staged = await this.text(['write-tree'], undefined, index);
        if (scope === 'working') { await this.run(['add', '-A', '--', '.'], undefined, index); }
        const target = scope === 'staged' ? staged : await this.text(['write-tree'], undefined, index);
        return { ...state, base, staged, target, scope };
    }
}

export async function withScratch<T>(task: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'smart-git-pilot-'));
    try { return await task(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
}
