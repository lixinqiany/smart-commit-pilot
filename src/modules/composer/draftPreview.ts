import { JSONParser } from '@streamparser/json';
import type { ChangedFile } from './changes';
import { Group, groupReader } from './plan';
import type { DraftCheck } from './validation';

type PreviewFile = { path: string; patch: string };
export interface PreviewDraft {
    id: string; message: string; paths: string[]; files?: PreviewFile[];
    checking?: boolean; check?: DraftCheck;
}
export type DraftStep = 'changes' | 'model' | 'analysis' | 'analysisRetry' | 'grouping' | 'groupingRetry';
export interface DraftStatus { type: 'status'; text: string; at: number; step?: DraftStep }
export type Report = (text: string, step?: DraftStep) => void;
export type DraftProgress =
    | DraftStatus
    | { type: 'append'; draft: PreviewDraft }
    | { type: 'replace'; drafts: PreviewDraft[] }
    | { type: 'diff'; index: number; files: PreviewFile[] }
    | { type: 'check'; index: number; result?: DraftCheck };

export function draftId(edits: number[]): string {
    return [...edits].sort((left, right) => left - right).join(',');
}

export class DraftPreview {
    private readonly paths = new Map<number, string>();
    private groups: Group[] = [];

    constructor(private readonly files: ChangedFile[], private readonly notify: (event: DraftProgress) => void) {
        for (const file of files) {
            for (const edit of file.edits) { this.paths.set(edit.id, file.after.path); }
        }
    }

    private describe(group: Group): PreviewDraft {
        return { id: draftId(group.edits), message: group.message, paths: [...new Set(group.edits.map(id => this.paths.get(id)!))] };
    }

    // Each grouping attempt owns a parser so a corrected reply replaces the rejected prefix.
    startResponse(anchors?: ReadonlySet<number>): (delta: string) => void {
        this.sync([]);
        const reader = groupReader(this.files, anchors);
        const parser = new JSONParser({ paths: ['$.commits.*'], keepStack: false });
        let started = false, failed = false;
        parser.onValue = ({ value }) => {
            const group = reader.read(value);
            this.groups.push(group);
            this.notify({ type: 'append', draft: this.describe(group) });
        };
        // The full-response parser owns validation, retries and errors.
        parser.onError = () => { failed = true; };
        return delta => {
            if (failed || parser.isEnded) { return; }
            if (!started) {
                const first = delta.indexOf('{'); // The response may start with a Markdown fence.
                if (first < 0) { return; }
                started = true;
                delta = delta.slice(first);
            }
            parser.write(delta);
        };
    }

    sync(groups: Group[]): void {
        if (this.groups.length === groups.length && this.groups.every((g, i) =>
            g.message === groups[i].message && g.edits.length === groups[i].edits.length &&
            g.edits.every((id, j) => id === groups[i].edits[j]))) { return; }
        this.groups = [...groups];
        this.notify({ type: 'replace', drafts: groups.map(g => this.describe(g)) });
    }
}
