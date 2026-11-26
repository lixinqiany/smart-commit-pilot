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
    readonly date: Date;
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
            '--format=%(refname)%09%(HEAD)%09%(upstream)%09%(committerdate:unix)%09%(symref)',
            'refs/heads', 'refs/remotes',
        ], '', undefined, 32 * 1024 * 1024);
        const branches: BranchRef[] = [];
        for (const line of output.split(/\r?\n/)) {
            const [ref, head, upstream, timestamp, symbolicTarget] = line.split('\t');
            if (ref && !symbolicTarget) {
                branches.push({
                    ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: head === '*',
                    remote: ref.startsWith('refs/remotes/'), upstream,
                    date: new Date(Number(timestamp) * 1000),
                });
            }
        }
        return branches;
    }

    async switchBranch(repository: Repository, name: string): Promise<void> {
        await this.#runGit(repository.rootUri.fsPath, ['switch', '--no-guess', '--', name]);
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
                stdio: ['pipe', 'pipe', 'pipe'],
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

            child.stdout.on('data', (chunk: Buffer) => {
                outputSize += chunk.length;
                if (outputSize > maxOutputBytes) {
                    child.kill();
                    finish(() => reject(new Error('Git output exceeded the maximum buffer size.')));
                    return;
                }
                stdout.push(chunk);
            });
            child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
            child.on('error', (error) => finish(() => reject(error)));
            child.on('close', (code) => finish(() => {
                if (code === 0) {
                    resolve(Buffer.concat(stdout).toString('utf8'));
                    return;
                }
                reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Git exited with code ${code}.`));
            }));
            child.stdin.on('error', (error) => finish(() => reject(error)));
            child.stdin.end(stdin);
        });
    }
}
