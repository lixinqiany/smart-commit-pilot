import * as vscode from 'vscode';
import { API, GitExtension, Repository } from './typings/git';

export class GitService {
    readonly #api: API;

    constructor() {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            throw new Error('vscode.git extension is not available.');
        }
        this.#api = extension.exports.getAPI(1);
    }

    getRepository(rootUri?: vscode.Uri): Repository {
        const repositories = this.#api.repositories;
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

    hasStagedChanges(repository: Repository = this.getRepository()): boolean {
        return repository.state.indexChanges.length > 0;
    }

    async getStagedDiff(repository: Repository = this.getRepository()): Promise<string> {
        return repository.diff(true);
    }

    setCommitMessage(message: string, repository: Repository = this.getRepository()): void {
        repository.inputBox.value = message;
    }
}
