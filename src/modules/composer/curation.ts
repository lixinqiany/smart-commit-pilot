import { l10n } from 'vscode';
import { ChangedFile } from './changes';
import { Draft, Group, Plan } from './plan';

export function draftSource(files: ChangedFile[], ids: number[]): ChangedFile[] {
    const selected = new Set(ids);
    return files.map(file => ({ ...file, edits: file.edits.filter(edit => selected.has(edit.id)) }))
        .filter(file => file.edits.length);
}

export function isDraft(drafts: Draft[], index: unknown): index is number {
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < drafts.length;
}

export function reorder(plan: Plan, from: number, to: number): Group[] {
    if (!isDraft(plan.drafts, from) || !isDraft(plan.drafts, to)) { throw new Error(l10n.t('Select a draft.')); }
    assertUnlockedRange(plan.drafts, from, to);
    const result = [...plan.drafts];
    result.splice(to, 0, ...result.splice(from, 1));
    return result;
}

export function moveEdits(plan: Plan, from: number, ids: number[], to: number | 'new'): { groups: Group[]; active: number } {
    if (!isDraft(plan.drafts, from) || (to !== 'new' && (!isDraft(plan.drafts, to) || to === from))) {
        throw new Error(l10n.t('Select a different draft.'));
    }
    assertUnlockedRange(plan.drafts, from, to === 'new' ? from : to);
    const draft = plan.drafts[from];
    const selected = new Set(ids);
    const moved = draft.edits.filter(id => selected.has(id));
    if (!selected.size || moved.length !== ids.length || moved.length !== selected.size) {
        throw new Error(l10n.t('Select changes from this draft.'));
    }
    const remaining = draft.edits.filter(id => !selected.has(id));
    if (to === 'new' && !remaining.length) {
        throw new Error(l10n.t('Keep at least one change in this draft to split it.'));
    }
    const groups: Group[] = plan.drafts.map(d => ({ message: d.message, edits: d.edits, locked: d.locked }));
    groups[from] = { message: draft.message, edits: remaining };
    const destination = to === 'new' ? { message: '', edits: moved } :
        { message: groups[to].message, edits: [...groups[to].edits, ...moved] };
    if (to === 'new') { groups.splice(from + 1, 0, destination); }
    else { groups[to] = destination; }
    if (!remaining.length) { groups.splice(from, 1); }
    return { groups, active: groups.indexOf(destination) };
}

export function assertUnlockedRange(groups: Group[], a: number, b = a): void {
    if (groups.slice(Math.min(a, b), Math.max(a, b) + 1).some(g => g.locked)) {
        throw new Error(l10n.t('Unlock the draft before changing it or moving changes across it.'));
    }
}

// Each lock separates two independently editable stretches. Keeping their original
// edit sets preserves the parent tree and the exact patch of every locked draft.
export function mergeUnlocked(previous: Group[], proposed: Group[]): Group[] {
    const owner = new Map<number, number>();
    const locks: Group[] = [];
    for (const group of previous) {
        if (group.locked) { locks.push(group); }
        else { for (const id of group.edits) { owner.set(id, locks.length); } }
    }
    const segments: Group[][] = Array.from({ length: locks.length + 1 }, () => []);
    for (const group of proposed) {
        const segment = owner.get(group.edits[0]);
        if (segment === undefined || group.edits.some(id => owner.get(id) !== segment)) {
            throw new Error(l10n.t('The proposed changes cross a locked draft.'));
        }
        segments[segment].push(group);
    }
    return segments.flatMap((groups, i) => i < locks.length ? [...groups, locks[i]] : groups);
}
