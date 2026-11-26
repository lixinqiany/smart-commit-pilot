import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { API, GitExtension, Repository } from './typings/git';

const ZERO_HASH = '0000000000000000000000000000000000000000';
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export interface BranchRef {
    readonly ref: string;
    readonly tip: string;
    readonly checkedOut: boolean;
    readonly name: string;
    readonly remote: boolean;
    readonly current: boolean;
    readonly upstream: string;
    readonly fetchRemote?: string;
    readonly upstreamSource?: string;
    readonly date: Date;
}

export interface BranchDeletion {
    branch: BranchRef;
    targets: RemoteDeletionTarget[];
}

export interface RemoteDeletionTarget {
    remote: string;
    ref: string;
    tip: string;
}

// A fetch refspec can map a server branch into a differently named local tracking ref.
function mapRef(ref: string, pattern: string, destination: string): string | undefined {
    const [prefix, suffix] = pattern.split('*');
    if (suffix === undefined) {
        return ref === pattern ? destination : undefined;
    }
    if (ref.startsWith(prefix) && ref.endsWith(suffix) && ref.length >= prefix.length + suffix.length) {
        return destination.replace('*', () => ref.slice(prefix.length, ref.length - suffix.length));
    }
    return undefined;
}

export interface RepositoryTag {
    name: string;
    hash: string;
    objectType: string;
    date?: Date;
    subject: string;
}

export interface Contributor {
    name: string;
    email: string;
    count: number;
    latest: Date;
    current: boolean;
}

function contributorScope(allBranches: boolean): string[] {
    return allBranches ? ['--branches', '--remotes', 'HEAD'] : ['HEAD'];
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
    const author = values.get('author') ?? '';
    const parsedAuthorEmail = values.get('author-mail')?.replace(/^<|>$/g, '');
    const authorTime = Number(values.get('author-time'));
    const isUncommitted = hash === ZERO_HASH;
    const isCurrentUser = isUncommitted
        || Boolean(identity.email && parsedAuthorEmail && identity.email.toLowerCase() === parsedAuthorEmail.toLowerCase())
        || Boolean(identity.name && identity.name === author);

    return {
        hash,
        author: author || vscode.l10n.t('Unknown author'),
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
            throw new Error(vscode.l10n.t('The built-in Git extension is unavailable.'));
        }
        this.api = extension.exports.getAPI(1);
    }

    getRepository(rootUri?: vscode.Uri): Repository {
        const repositories = this.api.repositories;
        if (repositories.length === 0) {
            throw new Error(vscode.l10n.t('No Git repository was found in this workspace.'));
        }
        if (!rootUri) {
            return repositories[0];
        }

        const repository = repositories.find((repo) => repo.rootUri.toString() === rootUri.toString());
        if (!repository) {
            throw new Error(vscode.l10n.t('No Git repository was found for {0}.', rootUri.toString()));
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
            '--format=%(refname)%09%(HEAD)%09%(upstream)%09%(committerdate:unix)%09%(symref)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(objectname)%09%(if)%(worktreepath)%(then)1%(end)',
            'refs/heads', 'refs/remotes',
        ], { maxOutputBytes: 32 * 1024 * 1024 });
        const branches: BranchRef[] = [];
        const remotes = repository.state.remotes.map(r => r.name).filter(name => !name.startsWith('-'))
            .sort((a, b) => b.length - a.length);
        for (const line of output.split(/\r?\n/)) {
            const [ref, head, upstream, timestamp, symbolicTarget, upstreamRemote, upstreamSource, tip, worktree] = line.split('\t');
            if (ref && !symbolicTarget) {
                const name = ref.replace(/^refs\/(heads|remotes)\//, '');
                const remote = ref.startsWith('refs/remotes/');
                const fetchRemote = remote ? remotes.find(r => name.startsWith(r + '/'))
                    : remotes.find(r => r === upstreamRemote && upstreamSource);
                branches.push({
                    ref, name, tip, checkedOut: worktree === '1', current: head === '*', remote, upstream, fetchRemote, upstreamSource,
                    date: new Date(Number(timestamp) * 1000),
                });
            }
        }
        return branches;
    }

    async switchBranch(repository: Repository, name: string): Promise<void> {
        await this.#runGit(repository.rootUri.fsPath, ['switch', '--no-guess', '--', name]);
    }

    async getBranchDeletion(repo: Repository, ref: string): Promise<BranchDeletion> {
        const branches = await this.getBranches(repo);
        const branch = branches.find(b => !b.remote && b.ref === ref);
        if (!branch) {
            throw new Error(vscode.l10n.t('Branch {0} no longer exists.', ref.replace(/^refs\/heads\//, '')));
        }
        if (branch.checkedOut || branch.current) {
            throw new Error(vscode.l10n.t('Branch {0} is checked out in a worktree.', branch.name));
        }
        const tracking = new Map(branches.filter(b => b.remote).map(b => [b.ref, b.tip]));
        const targets: RemoteDeletionTarget[] = [];
        if (branch.upstream || !tracking.size) {
            const tip = tracking.get(branch.upstream);
            if (tip && branch.fetchRemote && branch.upstreamSource?.startsWith('refs/heads/')) {
                targets.push({ remote: branch.fetchRemote, ref: branch.upstreamSource, tip });
            }
            return { branch, targets };
        }
        const configs = await repo.getConfigs();
        // A configured but unmapped upstream must not be replaced with an unrelated namesake.
        if (configs.some(c => c.key === 'branch.' + branch.name + '.merge')) {
            return { branch, targets };
        }
        for (const { name } of repo.state.remotes) {
            const specs = configs.filter(c => c.key === 'remote.' + name + '.fetch').map(c => c.value);
            if (name.startsWith('-') || specs.some(s => s.startsWith('^') && mapRef(ref, s.slice(1), ref))) {
                continue;
            }
            for (const spec of specs) {
                const [from, to] = spec.replace(/^\+/, '').split(':');
                const mapped = to && mapRef(ref, from, to);
                const tip = mapped && tracking.get(mapped);
                if (tip) {
                    targets.push({ remote: name, ref, tip });
                    break;
                }
            }
        }
        return { branch, targets };
    }

    async deleteLocalBranch(repo: Repository, plan: BranchDeletion, { force, target }: { force: boolean; target?: RemoteDeletionTarget }): Promise<void> {
        const cwd = repo.rootUri.fsPath;
        const { branch, targets } = await this.getBranchDeletion(repo, plan.branch.ref);
        if (branch.tip !== plan.branch.tip || (target && !targets.some(t =>
            t.remote === target.remote && t.ref === target.ref && t.tip === target.tip))) {
            throw new Error(vscode.l10n.t('Branch or upstream changed. Review the deletion again.'));
        }
        const deleteLocal = () => this.#runGit(cwd, ['branch', force ? '-D' : '-d', '--', branch.name]);
        if (!target) {
            await deleteLocal();
            return;
        }

        // The upstream cannot protect unmerged commits once both refs are removed.
        if (!force && (await this.#runGit(cwd, ['rev-list', '-1', branch.tip, target.tip, '--not', 'HEAD', '--'])).trim()) {
            throw new Error(vscode.l10n.t('Merge both branches into HEAD first, or select force deletion.'));
        }
        // Reject deletion if the server has moved since the displayed tracking ref was fetched.
        await this.#runGit(cwd, ['push', '--no-follow-tags', '--force-with-lease=' + target.ref + ':' + target.tip,
            '--', target.remote, ':' + target.ref]);
        try {
            const tip = await this.#runGit(cwd, ['rev-parse', '--verify', branch.ref]);
            if (tip.trim() !== branch.tip) {
                throw new Error(vscode.l10n.t('Branch or upstream changed. Review the deletion again.'));
            }
            await deleteLocal();
        } catch (error) {
            throw new Error(vscode.l10n.t('Remote branch {0} was deleted. Could not finish deleting local {1}. {2}',
                target.remote + '/' + target.ref.slice('refs/heads/'.length), branch.name, error instanceof Error ? error.message : String(error)));
        }
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
                source = mapRef(branch.ref, to, from);
                if (source) {
                    break;
                }
            }
        }
        if (!source) {
            throw new Error(vscode.l10n.t('No fetch mapping for {0} on {1}.', branch.name, remote));
        }
        await repo.fetch(remote, source);
    }

    async getTags(repo: Repository): Promise<RepositoryTag[]> {
        const cwd = repo.rootUri.fsPath;
        const output = await this.#runGit(cwd, ['for-each-ref', '--sort=refname', '--sort=-creatordate',
            '--format=%(refname:lstrip=2)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(creatordate:unix)%00%(subject)',
            'refs/tags'], { maxOutputBytes: 32 * 1024 * 1024 });
        const tags: RepositoryTag[] = [];
        for (const line of output.split('\n')) {
            if (!line) {
                continue;
            }
            const [name, object, type, target, targetType, time, subject] = line.split('\0');
            tags.push({ name, hash: target || object, objectType: targetType || type,
                date: time ? new Date(Number(time) * 1000) : undefined, subject });
        }
        // for-each-ref peels one layer. Resolve nested annotated tags together.
        const nested = tags.filter(tag => tag.objectType === 'tag');
        if (nested.length) {
            const peeled = await this.#runGit(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
                { stdin: nested.map(tag => tag.hash + '^{}\n').join('') });
            peeled.trimEnd().split('\n').forEach((line, i) => {
                [nested[i].hash, nested[i].objectType] = line.split(' ');
            });
        }
        return tags;
    }

    async getContributors(repo: Repository, allBranches: boolean): Promise<Contributor[]> {
        const contributors = new Map<string, Contributor>();
        const identity = await this.#getIdentity(repo);
        const tally = (line: string) => {
            const [name, email, time] = line.split('\0');
            if (time === undefined) {
                return;
            }
            const key = name + '\0' + email;
            const latest = new Date(Number(time) * 1000);
            const author = contributors.get(key);
            if (author) {
                author.count++;
                if (latest > author.latest) {
                    author.latest = latest;
                }
            } else {
                contributors.set(key, { name, email, count: 1, latest,
                    current: identity.name === name && identity.email?.toLowerCase() === email.toLowerCase() });
            }
        };
        // Count the entire history while keeping only one record per author in memory.
        await this.#runGit(repo.rootUri.fsPath, ['log', '--ignore-missing', '--no-merges', '--no-notes',
            '--no-show-signature', '--format=%aN%x00%aE%x00%at', ...contributorScope(allBranches), '--'], { onLine: tally });
        return [...contributors.values()].sort((a, b) => b.count - a.count || b.latest.getTime() - a.latest.getTime()
            || a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
    }

    getContributorHistory(repo: Repository, author: Contributor, allBranches: boolean, limit: number): Promise<HistoryCommit[]> {
        const identity = (author.name + ' <' + author.email + '>').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return this.readHistory(repo, ['--ignore-missing', '--no-merges', '--use-mailmap', '--extended-regexp',
            '--author=^' + identity, ...contributorScope(allBranches)], limit);
    }

    getBranchHistory(repo: Repository, ref: string, limit: number): Promise<HistoryCommit[]> {
        return this.readHistory(repo, [ref], limit);
    }

    private async readHistory(repo: Repository, revisions: string[], limit: number): Promise<HistoryCommit[]> {
        const output = await this.#runGit(repo.rootUri.fsPath, [
            'log', '--no-color', '--no-notes', '--no-show-signature', '--date-order', '-z',
            '--format=%H%x00%P%x00%aN%x00%aE%x00%ct%x00%s', '--max-count=' + limit, ...revisions, '--',
        ], { maxOutputBytes: 32 * 1024 * 1024 });
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
        ], { maxOutputBytes: 32 * 1024 * 1024 });
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
                '--no-decorate', '--format=%at%x00%B', commit.hash, '--'], { signal }),
            this.#runGit(repo.rootUri.fsPath, ['diff-tree', '-r', '--no-commit-id', '--raw', '--numstat', '-z', '-M',
                '--no-ext-diff', '--no-textconv', ...revisions, '--'], { signal, maxOutputBytes: 32 * 1024 * 1024 }),
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
                    { stdin: contents, signal }
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
        options: { stdin?: string; signal?: AbortSignal; maxOutputBytes?: number; onLine?: (line: string) => void } = {}
    ): Promise<string> {
        const { stdin = '', signal, maxOutputBytes = MAX_GIT_OUTPUT_BYTES, onLine } = options;
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

            if (onLine && child.stdout) {
                createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', onLine);
            } else {
                child.stdout?.on('data', (chunk: Buffer) => {
                    outputSize += chunk.length;
                    if (outputSize > maxOutputBytes) {
                        child.kill();
                        finish(() => reject(new Error(vscode.l10n.t('Git output exceeded the maximum buffer size.'))));
                        return;
                    }
                    stdout.push(chunk);
                });
            }
            child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
            child.on('error', (error) => finish(() => reject(error)));
            child.on('close', (code) => finish(() => {
                if (code === 0) {
                    resolve(Buffer.concat(stdout).toString('utf8'));
                    return;
                }
                reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || vscode.l10n.t('Git exited with code {0}.', String(code))));
            }));
            if (child.stdin) {
                child.stdin.on('error', (error) => finish(() => reject(error)));
                child.stdin.end(stdin);
            }
        });
    }
}
