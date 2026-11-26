import { join } from 'node:path';
import { l10n } from 'vscode';
import { ChangedFile, renderFile } from './changes';
import { ComposerGit, Snapshot, withScratch } from './git';
import { FileSelection, previewSelections } from './selection';
import type { PlanningSession } from './planner';
import type { DraftCheck } from './validation';

export interface Group { message: string; edits: number[]; locked?: boolean }
export interface DraftFile extends FileSelection { path: string; patch: string }
export interface Draft extends Group { tree: string; files: DraftFile[]; check?: DraftCheck }
export interface Plan { snapshot: Snapshot; source: ChangedFile[]; drafts: Draft[]; session?: PlanningSession; warning?: string }

export function parseGroups(raw: string, files: ChangedFile[]): Group[] {
    const error = () => new Error(l10n.t('The model returned an incomplete or overlapping split. Generate a new plan.'));
    const allowed = new Set(files.flatMap(file => file.edits.map(edit => edit.id)));
    let data;
    try { data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')); }
    catch { throw error(); }
    if (!Array.isArray(data?.commits) || !data.commits.length) { throw error(); }
    const seen = new Set<number>();
    const groups = data.commits.map((item: { message?: unknown; edits?: unknown } | null) => {
        if (typeof item?.message !== 'string' || !item.message.trim() || item.message.includes('\0') ||
            !Array.isArray(item.edits) || !item.edits.length) { throw error(); }
        const edits: number[] = [];
        for (const span of item.edits) {
            const range = typeof span === 'string' && /^(\d+)-(\d+)$/.exec(span);
            const start = range ? Number(range[1]) : span;
            const end = range ? Number(range[2]) : span;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end - start >= allowed.size || start > end) { throw error(); }
            for (let id = start; id <= end; id++) {
                if (!allowed.has(id) || seen.has(id)) { throw error(); }
                seen.add(id);
                edits.push(id);
            }
        }
        return { message: item.message.trim(), edits };
    });
    if (seen.size !== allowed.size) { throw error(); }
    return groups;
}

export async function buildPlan(git: ComposerGit, snapshot: Snapshot, files: ChangedFile[], groups: Group[]): Promise<Plan> {
    return withScratch(async dir => {
        const index = join(dir, 'index');
        await git.run(['read-tree', snapshot.base], undefined, index);
        const included = new Set<number>();
        const drafts: Draft[] = [];
        let previous = snapshot.base;
        for (const group of groups) {
            const current = new Set(group.edits);
            for (const id of current) { included.add(id); }
            const removals: string[] = [];
            const entries: string[] = [];
            const changed = files.filter(f => f.edits.some(e => current.has(e.id)));
            for (const file of changed) {
                const { before, after } = file;
                if (before.path !== after.path || after.mode === '000000') {
                    removals.push('0 ' + '0'.repeat(before.oid.length) + '\t' + before.path + '\0');
                }
                if (after.mode !== '000000') {
                    const oid = file.original ? await git.text(['hash-object', '-w', '--stdin'], renderFile(file, included)) : after.oid;
                    entries.push(after.mode + ' ' + oid + '\t' + after.path + '\0');
                }
            }
            await git.run(['update-index', '-z', '--index-info'], removals.concat(entries).join(''), index);
            const tree = await git.text(['write-tree'], undefined, index);
            if (tree === previous) { throw new Error(l10n.t('The plan contains an empty commit. Generate a new plan.')); }
            // Split Git's complete, byte-quoted unified diff at file headers. A real
            // content line always starts with a context, deletion or addition marker.
            const diff = (await git.run(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff',
                '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', previous, tree])).toString();
            const paths = (await git.run(['diff', '--name-only', '--no-renames', '-z', previous, tree])).toString().split('\0').filter(Boolean);
            const patches = diff.split(/^(?=diff --git )/m).filter(Boolean);
            const selections = previewSelections(changed, current, included);
            if (paths.length !== patches.length || paths.some(path => !selections.has(path))) {
                throw new Error(l10n.t('Could not build an exact diff preview.'));
            }
            const previews = paths.map((path, i) => ({ path, patch: patches[i], ...selections.get(path)! }));
            drafts.push({ message: group.message, edits: group.edits, locked: group.locked, tree, files: previews });
            previous = tree;
        }
        if (previous !== snapshot.target) { throw new Error(l10n.t('The proposed commits do not reproduce the selected changes.')); }
        return { snapshot, source: files, drafts };
    });
}
