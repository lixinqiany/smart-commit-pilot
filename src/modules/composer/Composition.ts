import { join } from 'node:path';
import * as vscode from 'vscode';
import { AdaptorFactory } from '../adaptor/AdaptorFactory';
import { logTokenUsage } from '../adaptor/logTokenUsage';
import { Configurator } from '../configuration/Configurator';
import { Venders } from '../configuration/configuration.constants';
import { messageRequest } from '../git/messageRequest';
import { collectChanges } from './changes';
import { assertUnlockedRange, draftSource } from './curation';
import { ComposerGit, Scope, withScratch } from './git';
import { buildPlan, Group, Plan } from './plan';
import { Ask, chooseDepth, Depth, PlannerContext, planGroups, PlanningSession } from './planner';
import { dependencyOrder, intermediateErrors, SequenceValidator } from './validation';

const t = vscode.l10n.t;
type Report = (text: string) => void;

async function withProgress<T>(signal: AbortSignal, run: (signal: AbortSignal, report: Report) => Promise<T>): Promise<T | undefined> {
    if (signal.aborted) { return; }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Prepare commit drafts'), cancellable: true },
        async (progress, token) => {
            const abort = new AbortController();
            const cancel = () => abort.abort();
            const subscription = token.onCancellationRequested(cancel);
            signal.addEventListener('abort', cancel, { once: true });
            try {
                if (signal.aborted || token.isCancellationRequested) { return; }
                const result = await run(abort.signal, message => progress.report({ message }));
                if (!abort.signal.aborted) { return result; }
            } catch (err) { if (!abort.signal.aborted) { throw err; } }
            finally { subscription.dispose(); signal.removeEventListener('abort', cancel); }
        });
}

export class Composition {
    constructor(private readonly git: ComposerGit, private readonly config: Pick<Configurator, 'getModel' | 'setupModel' | 'getPrompt' | 'getBaseURLandSecrets' | 'log'>) {}
    get model(): string { return this.config.getModel('composer.model'); }
    selectModel() { return this.config.setupModel('composer.model'); }

    async paths(scope: Scope): Promise<string[]> {
        const snapshot = await withScratch(dir => this.git.capture(scope, join(dir, 'index')));
        const raw = await this.git.run(['diff', '--no-renames', '--name-only', '-z', snapshot.base, snapshot.target]);
        return raw.toString().split('\0').filter(Boolean);
    }

    async start(scope: Scope, guidance: string, manual: boolean, signal: AbortSignal, depth: Depth = 'auto') {
        return withProgress(signal, async (signal, report) => {
            const snapshot = await withScratch(dir => this.git.capture(scope, join(dir, 'index')));
            if (snapshot.base === snapshot.target) { throw new Error(t('No changes in the selected scope.')); }
            const files = await collectChanges(this.git, snapshot);
            const build = (groups: Group[]) => buildPlan(this.git, snapshot, files, groups);
            const validator = new SequenceValidator(this.git, signal);
            if (manual) {
                return validator.verify(await build([{ message: '', edits: files.flatMap(f => f.edits.map(e => e.id)) }]), report);
            }
            const connection = await this.connect(signal);
            if (!connection) { return; }
            const { model, ask } = connection;
            const ctx = { model, convention: this.config.getPrompt(), files, guidance };
            const result = await planGroups(ctx, { deep: chooseDepth(files, depth), instructions: [] }, ask, report);
            return this.review(await build(result.groups), result.session, ctx, ask, validator, report);
        });
    }

    async refine(plan: Plan, guidance: string, signal: AbortSignal) {
        if (plan.drafts.every(d => d.locked)) { throw new Error(t('Unlock a draft to continue.')); }
        return withProgress(signal, async (signal, report) => {
            const connection = await this.connect(signal);
            if (!connection) { return; }
            const { model, ask } = connection;
            const ctx = { model, convention: this.config.getPrompt(), files: plan.source, guidance, previous: plan.drafts };
            const session = plan.session ?? { deep: chooseDepth(plan.source, 'auto'), instructions: [] };
            const result = await planGroups(ctx, session, ask, report, true, intermediateErrors(plan));
            const revised = await buildPlan(this.git, plan.snapshot, plan.source, result.groups);
            return this.review(revised, result.session, ctx, ask, new SequenceValidator(this.git, signal), report);
        });
    }

    private async review(plan: Plan, session: PlanningSession, ctx: PlannerContext, ask: Ask, validator: SequenceValidator, report: Report) {
        const verify = async (groups: Group[]) => validator.verify(await buildPlan(this.git, plan.snapshot, plan.source, groups), report);
        let reviewed: Plan = await validator.verify(plan, report);
        let errors = intermediateErrors(reviewed);
        // Accept a local repair only after the new intermediate trees improve on the old ones.
        for (let i = 0; errors.length && i < plan.drafts.length; i++) {
            const order = dependencyOrder(reviewed);
            if (!order) { break; }
            const candidate = await verify(order);
            const remaining = intermediateErrors(candidate);
            if (candidate.drafts.some(d => d.check?.skipped) || remaining.length >= errors.length) { break; }
            reviewed = candidate;
            errors = remaining;
        }
        if (errors.length && session.deep) {
            try {
                const repaired = await planGroups({ ...ctx, previous: reviewed.drafts, guidance: '' }, session, ask, report, true, errors);
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
        assertUnlockedRange(plan.drafts, index);
        const draft = plan.drafts[index];
        if (draft.edits.length < 2) { throw new Error(t('This draft contains only one indivisible change.')); }
        return withProgress(signal, async (signal, report) => {
            const files = draftSource(plan.source, draft.edits);
            const connection = await this.connect(signal);
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

    async reword(plan: Plan, index: number, signal: AbortSignal) {
        assertUnlockedRange(plan.drafts, index);
        return withProgress(signal, async signal => {
            const draft = plan.drafts[index];
            const connection = await this.connect(signal);
            if (!connection) { return; }
            const message = await connection.ask(messageRequest(connection.model, draft.files.map(f => f.patch).join(''), this.config.getPrompt()));
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

    private async connect(signal: AbortSignal): Promise<{ model: string; ask: Ask } | undefined> {
        const vendor = await this.config.getBaseURLandSecrets();
        if (!vendor) { throw new Error(t('Smart Git Pilot: configure a provider first.')); }
        signal.throwIfAborted();
        const model = this.model || await this.selectModel();
        if (!model || signal.aborted) { return; }
        const adaptor = AdaptorFactory.create(vendor.provider as Venders, vendor.baseUrl, vendor.apiKey);
        const ask: Ask = async body => {
            signal.throwIfAborted();
            const response = await adaptor.createMessage(body, signal);
            logTokenUsage(response.usage, line => this.config.log(line));
            signal.throwIfAborted();
            return response.content.map(part => part.text).join('\n');
        };
        return { model, ask };
    }
}

