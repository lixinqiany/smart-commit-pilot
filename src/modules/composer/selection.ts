import type { ChangedFile } from './changes';

export interface SelectableEdit {
    id: number;
    removed: string[];
    added: string[];
}

export interface ChangeBlock {
    // Zero-based offsets in the trees immediately before and after this draft.
    oldStart: number;
    newStart: number;
    removed: number;
    added: number;
    units: SelectableEdit[];
}

export interface FileSelection {
    ids: number[];
    blocks?: ChangeBlock[];
}

// Git can align repeated lines differently when it prints a patch. Bind the
// controls to the same source edits used to build the trees, never to diff text.
function selection(file: ChangedFile, current: Set<number>, included: Set<number>): FileSelection {
    const ids: number[] = [];
    const blocks: ChangeBlock[] = [];
    let oldOffset = 0, newOffset = 0;
    for (const edit of file.edits) {
        if (!included.has(edit.id)) { continue; }
        const delta = edit.insert.length - edit.remove;
        if (current.has(edit.id)) {
            ids.push(edit.id);
            if (file.original !== undefined) {
                const oldStart = edit.start + oldOffset;
                const newStart = edit.start + newOffset;
                let block = blocks.at(-1);
                if (!block || oldStart !== block.oldStart + block.removed || newStart !== block.newStart + block.added) {
                    block = { oldStart, newStart, removed: 0, added: 0, units: [] };
                    blocks.push(block);
                }
                block.units.push({ id: edit.id, removed: file.original.slice(edit.start, edit.start + edit.remove), added: edit.insert });
                block.removed += edit.remove;
                block.added += edit.insert.length;
            }
        } else {
            oldOffset += delta;
        }
        newOffset += delta;
    }
    return { ids, blocks: ids.length > 1 && blocks.length ? blocks : undefined };
}

export function previewSelections(changed: ChangedFile[], current: Set<number>, included: Set<number>): Map<string, FileSelection> {
    const result = new Map<string, FileSelection>();
    for (const file of changed) {
        const part = selection(file, current, included);
        // A rename appears as two paths in the unified preview. Both represent
        // one edit. If paths overlap, keep those operations together.
        for (const path of new Set([file.before.path, file.after.path])) {
            const other = result.get(path);
            result.set(path, other ? { ids: other.ids.concat(part.ids) } : part);
        }
    }
    return result;
}
