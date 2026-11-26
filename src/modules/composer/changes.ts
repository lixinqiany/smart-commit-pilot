import { l10n } from 'vscode';
import { ComposerGit, Snapshot } from './git';

interface FileVersion { path: string; mode: string; oid: string }
export interface Edit {
    id: number;
    start: number;
    remove: number;
    insert: string[];
    description: string;
}
export interface ChangedFile {
    before: FileVersion;
    after: FileVersion;
    original?: string[];
    edits: Edit[];
}

function lines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function decode(buffer: Buffer): string | undefined {
    const value = buffer.toString('utf8');
    return !value.includes('\0') && Buffer.from(value).equals(buffer) ? value : undefined;
}

// Pair adjacent replacements when their lengths match. Keep unequal replacements together
// so an insertion/deletion is never paired with a guessed counterpart.
function textEdits(diff: string, original: string[], updated: string[]): Edit[] {
    const edits: Edit[] = [];
    for (const header of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/gm)) {
        const removed = Number(header[2] ?? 1);
        const added = Number(header[4] ?? 1);
        const oldStart = Number(header[1]) - (removed ? 1 : 0);
        const newStart = Number(header[3]) - (added ? 1 : 0);
        const count = !removed || !added || removed === added ? Math.max(removed, added) : 1;
        for (let i = 0; i < count; i++) {
            const start = oldStart + (removed ? i : 0);
            const remove = count === 1 ? removed : Math.min(1, removed);
            const insertStart = newStart + (added ? i : 0);
            const insert = updated.slice(insertStart, insertStart + (count === 1 ? added : Math.min(1, added)));
            const changes = [...original.slice(start, start + remove).map(s => '-' + s.trimEnd()),
                ...insert.map(s => '+' + s.trimEnd())];
            edits.push({ id: 0, start, remove, insert, description: [header[5].trim(), ...changes].filter(Boolean).join('\n') });
        }
    }
    return edits;
}

export async function collectChanges(git: ComposerGit, snapshot: Snapshot): Promise<ChangedFile[]> {
    const args = ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--find-renames', snapshot.base, snapshot.target];
    const raw = await git.run(args);
    const data = raw.toString('utf8');
    if (!Buffer.from(data).equals(raw)) { throw new Error(l10n.t('A changed filename cannot be represented as UTF-8.')); }
    const parts = data.split('\0');
    const files: ChangedFile[] = [];
    let nextId = 1;
    for (let i = 0; i < parts.length && parts[i];) {
        const [oldMode, newMode, oldOid, newOid, status] = parts[i++].slice(1).split(' ');
        const path = parts[i++];
        const newPath = status.startsWith('R') ? parts[i++] : path;
        const file: ChangedFile = {
            before: { path, mode: oldMode, oid: oldOid },
            after: { path: newPath, mode: newMode, oid: newOid }, edits: [],
        };
        // Preserve modes, renames, symlinks, gitlinks and binary data as whole Git entries.
        const simple = status === 'M' && oldMode === newMode && /^100/.test(oldMode);
        if (simple) {
            const diff = await git.text(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0',
                '--inter-hunk-context=0', oldOid, newOid]);
            if (/^@@ /m.test(diff)) {
                const original = decode(await git.run(['cat-file', 'blob', oldOid]));
                const updated = decode(await git.run(['cat-file', 'blob', newOid]));
                if (original !== undefined && updated !== undefined) {
                    file.original = lines(original);
                    file.edits = textEdits(diff, file.original, lines(updated));
                }
            }
        }
        // Short new text files can also contain two independent declarations.
        // Large additions stay atomic to keep generated assets from dominating the prompt.
        if (status === 'A' && /^100/.test(newMode) && Number(await git.text(['cat-file', '-s', newOid])) <= 32 * 1024) {
            const added = decode(await git.run(['cat-file', 'blob', newOid]));
            if (added) {
                file.original = [];
                file.edits = lines(added).map(line => ({ id: 0, start: 0, remove: 0,
                    insert: [line], description: '+' + line.trimEnd() }));
            }
        }
        if (!file.edits.length) {
            const paths = path === newPath ? [path] : [path, newPath];
            const patch = await git.text(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
                '--find-renames', snapshot.base, snapshot.target, '--', ...paths]);
            file.edits.push({ id: 0, start: 0, remove: 0, insert: [], description: patch.slice(0, 6000) });
        }
        for (const edit of file.edits) { edit.id = nextId++; }
        files.push(file);
    }
    return files;
}

export function renderFile(file: ChangedFile, included: Set<number>): string {
    const original = file.original!;
    const result: string[] = [];
    let cursor = 0;
    for (const edit of file.edits) {
        if (!included.has(edit.id)) { continue; }
        result.push(original.slice(cursor, edit.start).join(''), edit.insert.join(''));
        cursor = edit.start + edit.remove;
    }
    return result.join('') + original.slice(cursor).join('');
}
