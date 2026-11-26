import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { Composition } from './Composition';
import { isDraft, moveEdits, reorder } from './curation';
import { reviewLabels, scopeLabels } from './labels';
import { Plan } from './plan';

const t = vscode.l10n.t;

interface Action {
    type?: string; scope?: unknown; depth?: unknown; guidance?: unknown; messages?: unknown;
    from?: unknown; to?: unknown; edits?: unknown; revision?: unknown; request?: number;
}

export class ReviewPanel {
    private readonly panel: vscode.WebviewPanel;
    private busy = false;
    private revision = 0;
    private plan?: Plan;
    private readonly lifetime = new AbortController();

    constructor(extensionUri: vscode.Uri, private readonly repo: string, private readonly stagedFirst: boolean,
        private readonly composition: Composition,
        private readonly commit: (plan: Plan) => Promise<void>, onClose: () => void) {
        const resources = vscode.Uri.joinPath(extensionUri, 'media', 'composer');
        this.panel = vscode.window.createWebviewPanel('smartGitPilot.commitReview', t('Split changes into commits'),
            vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        const modelSetting = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('smartCommitPilot.composer.model')) {
                void this.panel.webview.postMessage({ type: 'model', model: this.composition.model });
            }
        });
        this.panel.onDidDispose(() => { this.lifetime.abort(); modelSetting.dispose(); onClose(); });
        this.panel.webview.onDidReceiveMessage(action => { void this.receive(action); });
        const web = this.panel.webview;
        const nonce = randomBytes(18).toString('base64');
        const asset = (name: string) => web.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
        web.html = `<!doctype html><html lang="${vscode.env.language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src ${web.cspSource} 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${asset('review.css')}"></head>
<body><main id="review"></main><script type="module" nonce="${nonce}" src="${asset('review.js')}"></script></body></html>`;
    }

    reveal(): void { this.panel.reveal(); }
    dispose(): void { this.panel.dispose(); }

    private show(active = 0): void {
        const model = this.composition.model;
        if (!this.plan) {
            const choices = [
                { scope: 'staged', title: t('Staged changes'), detail: t('Only the changes selected with + or git add') },
                { scope: 'working', title: t('All saved changes'),
                    detail: t('New, edited and deleted files, even if unstaged. Skips ignored new files.') },
            ];
            void this.panel.webview.postMessage({ type: 'scopes', repo: this.repo, model, labels: scopeLabels(),
                choices: this.stagedFirst ? choices : choices.reverse() });
            return;
        }
        this.panel.title = t('Review split commits');
        void this.panel.webview.postMessage({ type: 'plan', repo: this.repo, model, revision: ++this.revision, active, warning: this.plan.warning,
            scope: this.plan.snapshot.scope === 'working' ? t('All saved changes') : t('Staged changes'),
            drafts: this.plan.drafts.map(({ message, files, edits, locked, check }) => ({ message, files, locked, check, canSplit: edits.length > 1 })),
            labels: reviewLabels(this.plan.drafts.length) });
    }

    private display(plan: Plan | undefined, active = 0): void {
        if (plan && !this.lifetime.signal.aborted) { this.plan = plan; this.show(active); }
    }

    private async receive(action: Action | null): Promise<void> {
        const signal = this.lifetime.signal;
        if (!action || signal.aborted) { return; }
        if (action.type === 'ready') { this.show(); return; }
        if (action.type === 'cancel' && (!this.plan || !this.busy)) { this.dispose(); return; }
        if (!this.plan && action.type === 'files' && (action.scope === 'working' || action.scope === 'staged')) {
            try {
                const paths = await this.composition.paths(action.scope);
                if (!signal.aborted) { void this.panel.webview.postMessage({ type: 'files', request: action.request, paths }); }
            } catch (err) {
                if (!signal.aborted) { void this.panel.webview.postMessage({ type: 'files', request: action.request, error: String(err) }); }
            }
            return;
        }
        if (this.busy) { return; }
        this.busy = true;
        try {
            if (action.type === 'model') {
                await this.composition.selectModel();
                return;
            }
            if (!this.plan) {
                if ((action.type !== 'choose' && action.type !== 'manual') ||
                    (action.scope !== 'staged' && action.scope !== 'working') || typeof action.guidance !== 'string') { return; }
                this.display(await this.composition.start(action.scope, action.guidance, action.type === 'manual', signal,
                    action.depth === 'deep' || action.depth === 'quick' ? action.depth : 'auto'));
                return;
            }
            if (action.revision !== this.revision) { return; }
            const messages = action.messages;
            if (!Array.isArray(messages) || messages.length !== this.plan.drafts.length ||
                messages.some(m => typeof m !== 'string' || m.includes('\0'))) { return; }
            const plan = { ...this.plan, drafts: this.plan.drafts.map((d, i) => ({ ...d, message: d.locked ? d.message : messages[i] })) };
            if (action.type === 'apply') { await this.commitReviewed(plan); return; }
            if (action.type === 'refine') {
                if (typeof action.guidance === 'string') {
                    this.display(await this.composition.refine(plan, action.guidance, signal));
                }
                return;
            }
            const from = action.from;
            if (!isDraft(plan.drafts, from)) { return; }
            if (action.type === 'lock') {
                plan.drafts[from].locked = !plan.drafts[from].locked;
                this.display(plan, from);
            } else if (action.type === 'split') {
                const guidance = await vscode.window.showInputBox({ title: t('Split this draft with AI…'),
                    prompt: t('AI will replace only this draft. Other drafts keep their changes and messages.'),
                    placeHolder: t('Which changes should go in separate commits?'), ignoreFocusOut: true });
                if (guidance !== undefined && !signal.aborted) {
                    this.display(await this.composition.split(plan, from, guidance, signal), from);
                }
            } else if (action.type === 'reword') {
                this.display(await this.composition.reword(plan, from, signal), from);
            } else if (action.type === 'reorder' && isDraft(plan.drafts, action.to)) {
                this.display(await this.composition.rebuild(plan, reorder(plan, from, action.to), signal), action.to);
            } else if (action.type === 'move' && Array.isArray(action.edits) && action.edits.every(Number.isSafeInteger)) {
                const to = action.to ?? await this.pickDestination(plan, from, action.edits.length);
                if (signal.aborted || (to !== 'new' && !isDraft(plan.drafts, to))) { return; }
                const change = moveEdits(plan, from, action.edits, to);
                this.display(await this.composition.rebuild(plan, change.groups, signal), change.active);
            }
        } catch (err) {
            if (!signal.aborted) {
                void this.panel.webview.postMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
            }
        } finally {
            this.busy = false;
            if (!signal.aborted) { void this.panel.webview.postMessage({ type: 'idle' }); }
        }
    }

    private async pickDestination(plan: Plan, from: number, count: number) {
        const choices: { label: string; target: number | 'new' }[] = plan.drafts.flatMap((d, i) => i === from ||
            plan.drafts.slice(Math.min(i, from), Math.max(i, from) + 1).some(g => g.locked) ? [] :
            [{ label: (i + 1) + '. ' + (d.message.trim().split('\n')[0] || t('Untitled commit')), target: i }]);
        if (count < plan.drafts[from].edits.length) { choices.unshift({ label: t('Move to new draft'), target: 'new' }); }
        if (!choices.length) { throw new Error(t('Keep at least one change in this draft to split it.')); }
        return (await vscode.window.showQuickPick(choices, { title: t('Move selected changes…'),
            placeHolder: t('Choose a destination. Moving all changes removes the empty draft.') }))?.target;
    }

    private async commitReviewed(plan: Plan): Promise<void> {
        const drafts = plan.drafts.map(d => ({ ...d, message: d.message.trim() }));
        if (drafts.some(d => !d.message)) { throw new Error(t('Each draft needs a valid commit message.')); }
        const button = t('Create commits');
        const choice = await vscode.window.showWarningMessage(t('Create the reviewed commits in {0}?', this.repo),
            { modal: true, detail: drafts.map((d, i) => (i + 1) + '. ' + d.message.split('\n')[0] +
                (d.check?.issues.length ? ' · ' + t('New issues ({0})', d.check.issues.length) : '')).join('\n') }, button);
        if (choice !== button || this.lifetime.signal.aborted) { return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating reviewed commits…') },
            () => this.commit({ ...plan, drafts }));
        this.dispose();
        void vscode.window.showInformationMessage(t('Created {0} commits in {1}.', drafts.length, this.repo));
    }
}
