import { execFile } from 'node:child_process';
import { access, mkdir, symlink } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { env, l10n } from 'vscode';
import { ComposerGit, withScratch } from './git';
import { Group, Plan } from './plan';

interface Issue { file?: string; line?: number; code: string; message: string; missing?: string }
export interface DraftCheck { checks: string[]; issues: Issue[]; existing: number; skipped?: string }
type Result = Omit<DraftCheck, 'existing'>;
const manifests = /(^|\/)(package|composer)\.json$/;

function runCompiler(library: string, root: string, configs: string[], signal: AbortSignal): Promise<Issue[]> {
    return new Promise((accept, reject) => {
        const child = execFile(process.execPath, [join(__dirname, 'typecheck.js'), library, root], {
            cwd: root, signal, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' },
        }, (err, data, stderr) => {
            if (err) { reject(new Error(stderr.trim() || err.message)); return; }
            try { accept(JSON.parse(data)); } catch (error) { reject(error); }
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(JSON.stringify(configs));
    });
}

async function checkTree(git: ComposerGit, tree: string, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();
    const paths = (await git.text(['ls-tree', '-r', '-z', '--name-only', tree])).split('\0');
    const checks = ['Git'];
    const issues: Issue[] = [];
    for (const path of paths.filter(p => manifests.test(p))) {
        const contents = await git.text(['cat-file', 'blob', tree + ':' + path]);
        try { JSON.parse(contents); }
        catch { issues.push({ file: path, code: 'JSON', message: l10n.t('Invalid JSON syntax.') }); }
    }
    if (paths.some(p => manifests.test(p))) { checks.push('JSON'); }
    const configs = paths.filter(p => posix.basename(p) === 'tsconfig.json' && !p.split('/').includes('node_modules'));
    if (!configs.length) { return { checks, issues }; }
    const library = join(env.appRoot, 'extensions', 'node_modules', 'typescript', 'lib', 'typescript.js');
    try {
        await access(library);
        const found = await withScratch(async dir => {
            const root = join(dir, 'source'), index = join(dir, 'index');
            await mkdir(root);
            await git.run(['read-tree', tree], undefined, index);
            await git.run(['checkout-index', '--all', '--prefix=' + root + sep], undefined, index);
            // Mirror installed dependency locations for root projects and nested workspaces.
            const dirs = new Set(['.']);
            for (const path of paths.filter(p => configs.includes(p) || posix.basename(p) === 'package.json')) {
                for (let parent = posix.dirname(path); !dirs.has(parent); parent = posix.dirname(parent)) { dirs.add(parent); }
            }
            for (const folder of dirs) {
                const deps = join(git.root, folder, 'node_modules');
                try { await access(deps); await symlink(deps, join(root, folder, 'node_modules'), 'junction'); }
                catch (err) { if (!['EEXIST', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) { throw err; } }
            }
            return runCompiler(library, root, configs, signal);
        });
        checks.push('TypeScript');
        issues.push(...found);
    } catch (err) {
        signal.throwIfAborted();
        return { checks, issues, skipped: l10n.t('TypeScript check unavailable. {0}', String(err).slice(0, 300)) };
    }
    return { checks, issues };
}
function key(issue: Issue) { return JSON.stringify([issue.file, issue.code, issue.message]); }

export class SequenceValidator {
    private readonly cache = new Map<string, Result>();
    constructor(private readonly git: ComposerGit, private readonly signal: AbortSignal) {}
    private async result(tree: string) {
        const cached = this.cache.get(tree);
        if (cached) { return cached; }
        const result = await checkTree(this.git, tree, this.signal);
        this.cache.set(tree, result);
        return result;
    }
    async verify(plan: Plan, report: (text: string) => void): Promise<Plan> {
        const base = await this.result(plan.snapshot.base);
        const drafts = [];
        for (const [i, draft] of plan.drafts.entries()) {
            this.signal.throwIfAborted();
            report(l10n.t('Checking commit {0} of {1}…', i + 1, plan.drafts.length));
            const result = await this.result(draft.tree);
            const counts = new Map<string, number>();
            for (const issue of base.issues) { const id = key(issue); counts.set(id, (counts.get(id) ?? 0) + 1); }
            const issues = result.issues.filter(issue => {
                const id = key(issue), count = counts.get(id) ?? 0;
                if (!count) { return true; }
                counts.set(id, count - 1);
                return false;
            });
            drafts.push({ ...draft, check: { ...result, issues, existing: result.issues.length - issues.length } });
        }
        return { ...plan, drafts };
    }
}

export function dependencyOrder(plan: Plan): Group[] | undefined {
    const final = new Set(plan.drafts.at(-1)?.check?.issues.map(key));
    for (const [index, draft] of plan.drafts.entries()) {
        if (draft.locked) { continue; }
        for (const issue of draft.check?.issues ?? []) {
            if (!issue.missing || final.has(key(issue))) { continue; }
            const stem = issue.missing.replace(/\.[cm]?jsx?$/, '');
            const candidates = new Set([issue.missing, ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json'].flatMap(ext =>
                [stem + '.' + ext, stem + '/index.' + ext])]);
            for (let i = index + 1; i < plan.drafts.length && !plan.drafts[i].locked; i++) {
                if (!plan.drafts[i].files.some(file => candidates.has(file.path))) { continue; }
                const reordered = [...plan.drafts];
                reordered.splice(index, 0, ...reordered.splice(i, 1));
                return reordered;
            }
        }
    }
}
export function intermediateErrors(plan: Plan): string[] {
    const final = new Set(plan.drafts.at(-1)?.check?.issues.map(key));
    return plan.drafts.slice(0, -1).flatMap((draft, i) => (draft.check?.issues ?? []).filter(issue => !final.has(key(issue)))
        .map(issue => '#' + (i + 1) + ' ' + (issue.file ?? '') + ' ' + issue.code + ' ' + issue.message));
}

