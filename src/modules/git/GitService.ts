import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { API, GitExtension, Repository } from './typings/git';

const ZERO_HASH = '0000000000000000000000000000000000000000';
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export interface BranchRef {
    readonly ref: string;
    readonly name: string;
    readonly remote: boolean;
    readonly current: boolean;
    readonly upstream: string;
    readonly fetchRemote?: string;
    readonly upstreamSource?: string;
    readonly date: Date;
}

export interface HistoryCommit {
    hash: string;
    parent?: string;
    author: string;
    authorEmail: string;
    date: Date;
    subject: string;
}

export interface CommitFile {
    path: string;
    previousPath: string;
    status: string;
}

export interface CommitHoverDetails {
    message: string;
    authoredAt: Date;
    files: { added: number; modified: number; deleted: number };
    additions: number;
    deletions: number;
}

export interface BlameInfo {
    hash: string;
    author: string;
    authorEmail?: string;
    authoredAt: Date;
    summary: string;
    isUncommitted: boolean;
    isCurrentUser: boolean;
}

interface GitIdentity {
    name?: string;
    email?: string;
}

export function parseLineBlame(output: string, identity: GitIdentity = {}): BlameInfo | undefined {
    const lines = output.split(/\r?\n/);
    const header = lines[0]?.match(/^([0-9a-f]{40})\s+\d+\s+\d+(?:\s+\d+)?$/i);
    if (!header) {
        return undefined;
    }

    const values = new Map<string, string>();
    for (const line of lines.slice(1)) {
        if (line.startsWith('\t')) {
            break;
        }
        const separator = line.indexOf(' ');
        if (separator > 0) {
            values.set(line.slice(0, separator), line.slice(separator + 1));
        }
    }

    const hash = header[1];
    const author = values.get('author') ?? 'Unknown';
    const parsedAuthorEmail = values.get('author-mail')?.replace(/^<|>$/g, '');
    const authorTime = Number(values.get('author-time'));
    const isUncommitted = hash === ZERO_HASH;
    const isCurrentUser = isUncommitted
        || Boolean(identity.email && parsedAuthorEmail && identity.email.toLowerCase() === parsedAuthorEmail.toLowerCase())
        || Boolean(identity.name && identity.name === author);

    return {
        hash,
        author,
        authorEmail: isUncommitted ? identity.email : parsedAuthorEmail,
        authoredAt: Number.isFinite(authorTime) ? new Date(authorTime * 1000) : new Date(0),
        summary: values.get('summary') ?? '',
        isUncommitted,
        isCurrentUser,
    };
}

export class GitService {
    readonly api: API;
    readonly #identityCache = new WeakMap<Repository, Promise<GitIdentity>>();

    constructor() {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            throw new Error('vscode.git extension is not available.');
        }
        this.api = extension.exports.getAPI(1);
    }

    getRepository(rootUri?: vscode.Uri): Repository {
        const repositories = this.api.repositories;
        if (repositories.length === 0) {
            throw new Error('No git repository found in the current workspace.');
        }
        if (!rootUri) {
            return repositories[0];
        }

        const repository = repositories.find((repo) => repo.rootUri.toString() === rootUri.toString());
        if (!repository) {
            throw new Error(`No git repository found for ${rootUri.toString()}.`);
        }
        return repository;
    }

    getRepositoryForUri(uri: vscode.Uri): Repository | undefined {
        return this.api.getRepository(uri) ?? undefined;
    }

    hasStagedChanges(repository: Repository = this.getRepository()): boolean {
        return repository.state.indexChanges.length > 0;
    }

    async getStagedDiff(repository: Repository = this.getRepository()): Promise<string> {
        return repository.diff(true);
    }

    setCommitMessage(message: string, repository: Repository = this.getRepository()): void {
        repository.inputBox.value = message;
    }

    async getBranches(repository: Repository): Promise<BranchRef[]> {
        // Full refs distinguish namesakes, and Git forbids tabs and newlines in ref names.
        const output = await this.#runGit(repository.rootUri.fsPath, [
            'for-each-ref', '--sort=refname', '--sort=-HEAD',
            '--format=%(refname)%09%(HEAD)%09%(upstream)%09%(committerdate:unix)%09%(symref)%09%(upstream:remotename)%09%(upstream:remoteref)',
            'refs/heads', 'refs/remotes',
        ], '', undefined, 32 * 1024 * 1024);
        const branches: BranchRef[] = [];
        const remotes = repository.state.remotes.map(r => r.name).filter(name => !name.startsWith('-'))
            .sort((a, b) => b.length - a.length);
        for (const line of output.split(/\r?\n/)) {
            const [ref, head, upstream, timestamp, symbolicTarget, upstreamRemote, upstreamSource] = line.split('\t');
            if (ref && !symbolicTarget) {
                const name = ref.replace(/^refs\/(heads|remotes)\//, '');
                const remote = ref.startsWith('refs/remotes/');
                const fetchRemote = remote ? remotes.find(r => name.startsWith(r + '/'))
                    : remotes.find(r => r === upstreamRemote && upstreamSource);
                branches.push({
                    ref, name, current: head === '*', remote, upstream, fetchRemote, upstreamSource,
                    date: new Date(Number(timestamp) * 1000),
                });
            }
        }
        return branches;
    }

    async switchBranch(repository: Repository, name: string): Promise<void> {
        await this.#runGit(repository.rootUri.fsPath, ['switch', '--no-guess', '--', name]);
    }

    async fetchBranch(repo: Repository, branch: BranchRef): Promise<void> {
        const remote = branch.fetchRemote;
        if (!remote) {
            throw new Error(vscode.l10n.t('Branch {0} has no remote to fetch from.', branch.name));
        }
        let source = branch.upstreamSource;
        if (branch.remote) {
            // Invert the configured fetch refspec: the displayed name can differ from the server's.
            const specs = await this.#runGit(repo.rootUri.fsPath, ['config', '--get-all', 'remote.' + remote + '.fetch']);
            for (const spec of specs.trim().split(/\r?\n/)) {
                const [from, to] = spec.replace(/^\+/, '').split(':');
                if (!to || !from.startsWith('refs/')) {
                    continue;
                }
                if (to === branch.ref) {
                    source = from;
                    break;
                }
                const [prefix, suffix] = to.split('*');
                if (suffix !== undefined && branch.ref.startsWith(prefix) && branch.ref.endsWith(suffix)
                    && branch.ref.length >= prefix.length + suffix.length) {
                    const match = branch.ref.slice(prefix.length, branch.ref.length - suffix.length);
                    source = from.replace('*', () => match);
                    break;
                }
            }
        }
        if (!source) {
            throw new Error(vscode.l10n.t('No fetch mapping for {0} on {1}.', branch.name, remote));
        }
        await repo.fetch(remote, source);
    }

    async getBranchHistory(repo: Repository, ref: string, limit: number): Promise<HistoryCommit[]> {
        const output = await this.#runGit(repo.rootUri.fsPath, [
            'log', '--no-color', '--no-notes', '--no-show-signature', '--date-order', '-z',
            '--format=%H%x00%P%x00%aN%x00%aE%x00%ct%x00%s', '--max-count=' + limit, ref, '--',
        ], '', undefined, 32 * 1024 * 1024);
        const fields = output.split('\0');
        const commits: HistoryCommit[] = [];
        for (let i = 0; i + 5 < fields.length; i += 6) {
            const [hash, parents, author, authorEmail, timestamp, subject] = fields.slice(i, i + 6);
            commits.push({ hash, parent: parents.split(' ')[0] || undefined, author, authorEmail, date: new Date(Number(timestamp) * 1000), subject });
        }
        return commits;
    }

    async getCommitFiles(repo: Repository, commit: HistoryCommit): Promise<CommitFile[]> {
        // Comparing the trees explicitly also handles merge commits relative to their first parent.
        const revisions = commit.parent ? [commit.parent, commit.hash] : ['--root', commit.hash];
        const output = await this.#runGit(repo.rootUri.fsPath, [
            'diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '-M', ...revisions, '--',
        ], '', undefined, 32 * 1024 * 1024);
        const fields = output.split('\0');
        const files: CommitFile[] = [];
        for (let i = 0; i < fields.length - 1;) {
            const status = fields[i++][0];
            const previousPath = fields[i++];
            const path = status === 'R' || status === 'C' ? fields[i++] : previousPath;
            files.push({ status, path, previousPath });
        }
        return files;
    }

    async getCommitHoverDetails(repo: Repository, commit: HistoryCommit, signal: AbortSignal): Promise<CommitHoverDetails> {
        const revisions = commit.parent ? [commit.parent, commit.hash] : ['--root', commit.hash];
        const [metadata, changes] = await Promise.all([
            this.#runGit(repo.rootUri.fsPath, ['show', '-s', '--no-color', '--no-notes', '--no-show-signature',
                '--no-decorate', '--format=%at%x00%B', commit.hash, '--'], '', signal),
            this.#runGit(repo.rootUri.fsPath, ['diff-tree', '-r', '--no-commit-id', '--raw', '--numstat', '-z', '-M',
                '--no-ext-diff', '--no-textconv', ...revisions, '--'], '', signal, 32 * 1024 * 1024),
        ]);
        const [timestamp, message] = metadata.split('\0');
        const files = { added: 0, modified: 0, deleted: 0 };
        let additions = 0, deletions = 0;
        const fields = changes.split('\0');
        // Git emits the raw status records first, then numstat records for the same comparison.
        let i = 0;
        while (fields[i]?.startsWith(':')) {
            const header = fields[i];
            const status = header[header.lastIndexOf(' ') + 1];
            if (status === 'A' || status === 'C') {
                files.added++;
            } else if (status === 'D') {
                files.deleted++;
            } else {
                files.modified++;
            }
            i += status === 'R' || status === 'C' ? 3 : 2;
        }
        for (; i < fields.length - 1; i++) {
            const entry = /^(\d+|-)\t(\d+|-)\t/.exec(fields[i]);
            if (!entry) {
                continue;
            }
            additions += Number(entry[1]) || 0;
            deletions += Number(entry[2]) || 0;
            if (fields[i].length === entry[0].length) {
                // With -z, a rename has an empty path here and two following path fields.
                i += 2;
            }
        }
        return { authoredAt: new Date(Number(timestamp) * 1000), message: message.trimEnd(), files, additions, deletions };
    }

    async createBranch(repository: Repository, name: string, startRef: string,
        mode: 'switch' | 'create' | 'track'): Promise<void> {
        const cwd = repository.rootUri.fsPath;
        // check-ref-format --branch can expand @{-n}. Only accept the literal name the user entered.
        const checked = await this.#runGit(cwd, ['check-ref-format', '--branch', name]);
        if (checked.trimEnd() !== name) {
            throw new Error(vscode.l10n.t('Enter a literal branch name.'));
        }
        const args = mode === 'create' ? ['branch', '--no-track', '--', name, startRef]
            : ['switch', mode === 'track' ? '--track' : '--no-track', '-c', name, '--', startRef];
        await this.#runGit(cwd, args);
    }

    async getLineBlame(
        fileUri: vscode.Uri,
        line: number,
        contents: string,
        signal?: AbortSignal
    ): Promise<BlameInfo | undefined> {
        const repository = this.getRepositoryForUri(fileUri);
        if (!repository || fileUri.scheme !== 'file') {
            return undefined;
        }

        const relativePath = path.relative(repository.rootUri.fsPath, fileUri.fsPath);
        if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
            return undefined;
        }

        try {
            const [output, identity] = await Promise.all([
                this.#runGit(
                    repository.rootUri.fsPath,
                    ['blame', '--line-porcelain', '-L', `${line + 1},${line + 1}`, '--contents', '-', '--', relativePath],
                    contents,
                    signal
                ),
                this.#getIdentity(repository),
            ]);
            return parseLineBlame(output, identity);
        } catch (error) {
            if (signal?.aborted) {
                return undefined;
            }
            return undefined;
        }
    }

    async #getIdentity(repository: Repository): Promise<GitIdentity> {
        const cachedIdentity = this.#identityCache.get(repository);
        if (cachedIdentity) {
            return cachedIdentity;
        }

        const identity = Promise.all([
            repository.getConfig('user.name').catch(() => undefined),
            repository.getConfig('user.email').catch(() => undefined),
        ]).then(([name, email]) => ({ name, email }));
        this.#identityCache.set(repository, identity);
        return identity;
    }

    #runGit(
        cwd: string,
        args: readonly string[],
        stdin = '',
        signal?: AbortSignal,
        maxOutputBytes = MAX_GIT_OUTPUT_BYTES
    ): Promise<string> {
        const gitPath = this.api.git.path;

        return new Promise((resolve, reject) => {
            const child = spawn(gitPath, [...args], {
                cwd,
                windowsHide: true,
                signal,
                stdio: [stdin.length > 0 ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputSize = 0;
            let settled = false;

            const finish = (callback: () => void): void => {
                if (settled) {
                    return;
                }
                settled = true;
                callback();
            };

            child.stdout?.on('data', (chunk: Buffer) => {
                outputSize += chunk.length;
                if (outputSize > maxOutputBytes) {
                    child.kill();
                    finish(() => reject(new Error('Git output exceeded the maximum buffer size.')));
                    return;
                }
                stdout.push(chunk);
            });
            child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
            child.on('error', (error) => finish(() => reject(error)));
            child.on('close', (code) => finish(() => {
                if (code === 0) {
                    resolve(Buffer.concat(stdout).toString('utf8'));
                    return;
                }
                reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Git exited with code ${code}.`));
            }));
            if (child.stdin) {
                child.stdin.on('error', (error) => finish(() => reject(error)));
                child.stdin.end(stdin);
            }
        });
    }
}
