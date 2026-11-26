import { join } from 'node:path';
import * as vscode from 'vscode';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { Configurator } from '../configuration/Configurator';
import { Venders } from '../configuration/configuration.constants';
import { TaskLog } from '../configuration/TaskLog';
import { messageRequest } from '../git/messageRequest';
import { collectChanges } from './changes';
import { DraftPreview, DraftProgress, Report } from './draftPreview';
import { assertUnlockedRange, draftSource } from './curation';
import { ComposerGit, Scope, withScratch } from './git';
import { buildPlan, Group, Plan } from './plan';
import { Ask, chooseDepth, Depth, PlannerContext, planGroups, PlanningSession } from './planner';
import { CheckProgress, dependencyOrder, intermediateErrors, SequenceValidator } from './validation';

const t = vscode.l10n.t;

async function withProgress<T>(signal: AbortSignal, run: (signal: AbortSignal, report: Report) => Promise<T>,
    task?: TaskLog): Promise<T | undefined> {
    if (signal.aborted) { task?.stop('cancelled'); return; }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Prepare commit drafts'), cancellable: true },
        async (progress, token) => {
            const abort = new AbortController();
            const cancel = () => abort.abort();
            const subscription = token.onCancellationRequested(cancel);
            signal.addEventListener('abort', cancel, { once: true });
            try {
                if (signal.aborted || token.isCancellationRequested) { cancel(); return; }
                const result = await run(abort.signal, (message, step) => {
                    progress.report({ message });
                    if (!abort.signal.aborted) { task?.progress(step ?? 'composer', { message }); }
                });
                if (!abort.signal.aborted) { return result; }
            } catch (err) { if (!abort.signal.aborted) { throw err; } }
            finally {
                if (abort.signal.aborted) { task?.stop('cancelled'); }
                subscription.dispose();
                signal.removeEventListener('abort', cancel);
            }
        });
}

export class Composition {
    private lastAnalysis?: { key: string; analysis: NonNullable<PlanningSession['analysis']> };

    constructor(private readonly git: ComposerGit, private readonly config: Pick<Configurator, 'getModel' | 'setupModel' | 'getPrompt' | 'getBaseURLandSecrets' | 'log'>) {}
    get model(): string { return this.config.getModel('composer.model'); }
    selectModel() { return this.config.setupModel('composer.model'); }

    private runTask<T>(operation: string, scope: Scope, signal: AbortSignal,
        run: (signal: AbortSignal, report: Report, task: TaskLog) => Promise<T>) {
        return TaskLog.run(line => this.config.log(line), operation, { repository: this.git.root, scope },
            task => withProgress(signal, (signal, report) => run(signal, report, task), task));
    }

    async previewFiles(scope: Scope) {
        const snapshot = await withScratch(dir => this.git.capture(scope, join(dir, 'index')));
        const raw = await this.git.run(['diff', '--find-renames', '--name-status', '-z', snapshot.base, snapshot.target]);
        const parts = raw.toString().split('\0');
        const files: { path: string; status: string; previousPath?: string }[] = [];
        for (let i = 0; parts[i];) {
            const status = parts[i++][0];
            const path = parts[i++];
            files.push(status === 'R' || status === 'C' ? { status, previousPath: path, path: parts[i++] } : { status, path });
        }
        return files;
    }

    async start(scope: Scope, guidance: string, manual: boolean, signal: AbortSignal, depth: Depth = 'auto',
        onProgress?: (event: DraftProgress) => void) {
        return this.runTask(manual ? 'group_manually' : 'generate_commit_drafts', scope, signal, async (signal, notification, task) => {
            const publish = (event: DraftProgress) => { if (!signal.aborted) { onProgress?.(event); } };
            const report: Report = (text, step) => {
                notification(text, step);
                publish({ type: 'status', text, at: performance.now(), ...(step ? { step } : {}) });
            };
            report(t('Reading selected changes…'), 'changes');
            const snapshot = await withScratch(dir => this.git.capture(scope, join(dir, 'index')));
            if (snapshot.base === snapshot.target) { throw new Error(t('No changes in the selected scope.')); }
            signal.throwIfAborted();
            const files = await collectChanges(this.git, snapshot, signal);
            const validator = new SequenceValidator(this.git, signal);
            if (manual) {
                const edits = files.flatMap(file => file.edits.map(edit => edit.id));
                return validator.verify(await buildPlan(this.git, snapshot, files, [{ message: '', edits }]), report);
            }
            report(t('Read {0} changed files.', files.length), 'changes');
            if (!this.model) { report(t('Selecting a split model…'), 'model'); }
            const connection = await this.connect(signal, task);
            if (!connection) { return; }
            const { model, ask } = connection;
            const ctx = { model, convention: this.config.getPrompt(), files, guidance };
            const preview = onProgress ? new DraftPreview(files, publish) : undefined;
            const deep = chooseDepth(files, depth);
            const key = JSON.stringify([snapshot.base, snapshot.target, scope, connection.provider, connection.baseUrl, model, ctx.convention, guidance]);
            const analysis = deep && this.lastAnalysis?.key === key ? this.lastAnalysis.analysis : undefined;
            task.progress('plan_drafts', { mode: deep ? 'deep' : 'quick', reusedAnalysis: !!analysis, files: files.length });
            // Retry a failed or interrupted attempt with a fresh analysis next time.
            if (deep) { this.lastAnalysis = undefined; }
            const result = await planGroups(ctx, { deep, analysis, instructions: [] }, ask, report, { preview });
            signal.throwIfAborted();
            const total = result.groups.length;
            const reportDiffs = (ready: number) => report(t('Preparing draft diffs ({0}/{1})…', ready, total));
            reportDiffs(0);
            const plan = await buildPlan(this.git, snapshot, files, result.groups, (draft, index) => {
                signal.throwIfAborted();
                if (onProgress) { publish({ type: 'diff', index, files: draft.files.map(({ path, patch }) => ({ path, patch })) }); }
                if (index + 1 < total) { reportDiffs(index + 1); }
            });
            let checked = 0;
            const onCheck: CheckProgress | undefined = onProgress ? (index, result) => {
                publish({ type: 'check', index, result });
                if (result) { checked++; }
                if (result || index === 0) { report(t('Draft checks complete: {0}/{1}', checked, total)); }
            } : undefined;
            const reviewed = await this.review(plan, result.session, ctx, ask, validator, report, onCheck);
            if (result.session.analysis && !signal.aborted && !intermediateErrors(reviewed).length &&
                reviewed.drafts.every(draft => draft.check && !draft.check.skipped)) {
                this.lastAnalysis = { key, analysis: result.session.analysis };
            }
            return reviewed;
        });
    }

    async refine(plan: Plan, guidance: string, signal: AbortSignal) {
        return this.runTask('refine_commit_drafts', plan.snapshot.scope, signal, async (signal, report, task) => {
            if (plan.drafts.every(d => d.locked)) { throw new Error(t('Unlock a draft to continue.')); }
            const connection = await this.connect(signal, task);
            if (!connection) { return; }
            const { model, ask } = connection;
            const ctx = { model, convention: this.config.getPrompt(), files: plan.source, guidance, previous: plan.drafts };
            const session = plan.session ?? { deep: chooseDepth(plan.source, 'auto'), instructions: [] };
            const result = await planGroups(ctx, session, ask, report, { mode: 'refine', feedback: intermediateErrors(plan) });
            const revised = await buildPlan(this.git, plan.snapshot, plan.source, result.groups);
            return this.review(revised, result.session, ctx, ask, new SequenceValidator(this.git, signal), report);
        });
    }

    private async review(plan: Plan, session: PlanningSession, ctx: PlannerContext, ask: Ask, validator: SequenceValidator,
        report: Report, onCheck?: CheckProgress) {
        const verify = async (groups: Group[]) => {
            const candidate = await buildPlan(this.git, plan.snapshot, plan.source, groups);
            if (onCheck) { report(t('Checking the adjusted sequence…')); }
            return validator.verify(candidate, onCheck ? () => {} : report);
        };
        let reviewed: Plan = await validator.verify(plan, report, onCheck);
        let errors = intermediateErrors(reviewed);
        // Accept a local repair only after the new intermediate trees improve on the old ones.
        for (let i = 0; errors.length && i < plan.drafts.length; i++) {
            const order = dependencyOrder(reviewed);
            if (!order) { break; }
            report(t('Adjusting commit order…'));
            const candidate = await verify(order);
            const remaining = intermediateErrors(candidate);
            if (candidate.drafts.some(d => d.check?.skipped) || remaining.length >= errors.length) { break; }
            reviewed = candidate;
            errors = remaining;
        }
        if (errors.length && session.deep) {
            try {
                const repaired = await planGroups({ ...ctx, previous: reviewed.drafts, guidance: '' }, session, ask, report, { mode: 'repair', feedback: errors });
                const candidate = await verify(repaired.groups);
                if (!candidate.drafts.some(d => d.check?.skipped) && intermediateErrors(candidate).length < errors.length) { reviewed = candidate; }
            } catch (err) {
                // A correction is optional. Keep the verified, editable proposal on a provider failure.
                reviewed = { ...reviewed, warning: t('Could not repair the split automatically. {0}', err instanceof Error ? err.message : String(err)) };
            }
        }
        return { ...reviewed, session };
    }

    async split(plan: Plan, index: number, guidance: string, signal: AbortSignal) {
        return this.runTask('split_commit_draft', plan.snapshot.scope, signal, async (signal, report, task) => {
            assertUnlockedRange(plan.drafts, index);
            const draft = plan.drafts[index];
            if (draft.edits.length < 2) { throw new Error(t('This draft contains only one indivisible change.')); }
            const files = draftSource(plan.source, draft.edits);
            const connection = await this.connect(signal, task);
            if (!connection) { return; }
            const { model, ask } = connection;
            const ctx = { model, convention: this.config.getPrompt(), files, guidance, previous: [draft], split: true };
            const result = await planGroups(ctx, { deep: chooseDepth(files, 'auto'), instructions: [] }, ask, report);
            if (result.groups.length < 2) { throw new Error(t('AI kept these changes together. Describe what to separate and try again.')); }
            const groups = [...plan.drafts.slice(0, index), ...result.groups, ...plan.drafts.slice(index + 1)];
            const updated = await buildPlan(this.git, plan.snapshot, plan.source, groups);
            return new SequenceValidator(this.git, signal).verify({ ...updated, session: plan.session }, report);
        });
    }

    async reword(plan: Plan, index: number, signal: AbortSignal, onText?: (delta: string) => void) {
        return this.runTask('rewrite_commit_draft_message', plan.snapshot.scope, signal, async (signal, _report, task) => {
            assertUnlockedRange(plan.drafts, index);
            const draft = plan.drafts[index];
            const connection = await this.connect(signal, task);
            if (!connection) { return; }
            const request = messageRequest(connection.model, draft.files.map(f => f.patch).join(''), this.config.getPrompt());
            const message = await connection.ask(request, { step: 'rewrite_message', attempt: 1 }, onText);
            if (!message.trim()) { throw new Error(t('Enter a commit message.')); }
            const drafts = [...plan.drafts];
            drafts[index] = { ...draft, message: message.trim() };
            return { ...plan, drafts };
        });
    }

    rebuild(plan: Plan, groups: Group[], signal: AbortSignal) {
        return withProgress(signal, async (signal, report) => {
            const updated = await buildPlan(this.git, plan.snapshot, plan.source, groups);
            return new SequenceValidator(this.git, signal).verify({ ...updated, session: plan.session }, report);
        });
    }

    private async connect(signal: AbortSignal, task: TaskLog): Promise<{ model: string; provider: string; baseUrl: string; ask: Ask } | undefined> {
        const vendor = await this.config.getBaseURLandSecrets();
        if (!vendor) { throw new Error(t('Smart Git Pilot: configure a provider first.')); }
        signal.throwIfAborted();
        const model = this.model || await this.selectModel();
        signal.throwIfAborted();
        if (!model) { task.stop('skipped', 'model_not_selected'); return; }
        const adaptor = AdaptorFactory.create(vendor.provider as Venders, vendor.baseUrl, vendor.apiKey);
        const ask: Ask = async (body, context, onText, onProgress) => {
            signal.throwIfAborted();
            const response = await task.modelCall({ provider: vendor.provider, model: body.model, ...context },
                signal, () => adaptor.createMessage(body, signal, onText, onProgress));
            signal.throwIfAborted();
            return response.content.map(part => part.text).join('\n');
        };
        return { model, provider: vendor.provider, baseUrl: vendor.baseUrl, ask };
    }
}

