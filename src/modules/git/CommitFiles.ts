import * as vscode from 'vscode';
import { posix } from 'node:path';
import { CommitFile, HistoryCommit } from './GitService';
import { Repository } from './typings/git';

type CommitContext = { repo: Repository; ref: string; commit: HistoryCommit };
export type CommitFileNode = CommitContext & { kind: 'file'; file: CommitFile; directory: string };
export type CommitFolderNode = CommitContext & { kind: 'commitFolder'; prefix: string; label: string; files: CommitFile[] };

const FLAT_FILE_LIMIT = 5;
const CHANGE_SCHEME = 'smart-git-pilot-change';
const colors: Record<string, string> = {
    A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified',
};

export function commitFileUri(uri: vscode.Uri, hash: string, status: string): vscode.Uri {
    return uri.with({ scheme: CHANGE_SCHEME, query: status, fragment: hash });
}

export const commitFileDecorations = {
    provideFileDecoration(uri) {
        if (uri.scheme !== CHANGE_SCHEME || !Object.hasOwn(colors, uri.query)) {
            return;
        }
        return new vscode.FileDecoration(uri.query, undefined,
            new vscode.ThemeColor('gitDecoration.' + colors[uri.query] + 'ResourceForeground'));
    },
} satisfies vscode.FileDecorationProvider;

export function commitFileRows({ repo, ref, commit }: CommitContext, files: CommitFile[], prefix = ''): (CommitFileNode | CommitFolderNode)[] {
    const folders = new Map<string, CommitFile[]>();
    const leaves: CommitFileNode[] = [];
    const addLeaf = (file: CommitFile) => {
        const directory = posix.dirname(file.path.slice(prefix.length));
        leaves.push({ kind: 'file', repo, ref, commit, file, directory: directory === '.' ? '' : directory });
    };
    for (const file of files) {
        const relative = file.path.slice(prefix.length);
        const slash = relative.indexOf('/');
        if (files.length <= FLAT_FILE_LIMIT || slash < 0) {
            addLeaf(file);
            continue;
        }
        const name = relative.slice(0, slash);
        const group = folders.get(name);
        if (group) {
            group.push(file);
        } else {
            folders.set(name, [file]);
        }
    }
    const directories: CommitFolderNode[] = [];
    for (const [name, group] of folders) {
        if (group.length === 1) {
            addLeaf(group[0]);
            continue;
        }
        let shared = prefix + name + '/';
        for (const part of group[0].path.slice(shared.length).split('/').slice(0, -1)) {
            const next = shared + part + '/';
            if (!group.every(file => file.path.startsWith(next))) {
                break;
            }
            shared = next;
        }
        directories.push({ kind: 'commitFolder', repo, ref, commit, label: shared.slice(prefix.length, -1), prefix: shared, files: group });
    }
    directories.sort((a, b) => a.label.localeCompare(b.label));
    leaves.sort((a, b) => posix.basename(a.file.path).localeCompare(posix.basename(b.file.path)) || a.file.path.localeCompare(b.file.path));
    return [...directories, ...leaves];
}
