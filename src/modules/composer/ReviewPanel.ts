import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { Plan } from './plan';

const t = vscode.l10n.t;

export class ReviewPanel {
    private readonly panel: vscode.WebviewPanel;
    private busy = false;
    private closed = false;

    constructor(extensionUri: vscode.Uri, private readonly repo: string, private plan: Plan,
        private readonly regenerate: (guidance: string) => Promise<Plan | undefined>,
        private readonly commit: (plan: Plan) => Promise<void>, onClose: () => void) {
        const resources = vscode.Uri.joinPath(extensionUri, 'media', 'composer');
        this.panel = vscode.window.createWebviewPanel('smartGitPilot.commitReview', t('Review split commits'),
            vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        this.panel.onDidDispose(() => { this.closed = true; onClose(); });
        this.panel.webview.onDidReceiveMessage(action => { void this.receive(action); });
        const web = this.panel.webview;
        const nonce = randomBytes(18).toString('base64');
        const asset = (name: string) => web.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
        web.html = `<!doctype html><html lang="${vscode.env.language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${asset('review.css')}"></head>
<body><main id="review"></main><script nonce="${nonce}" src="${asset('review.js')}"></script></body></html>`;
    }

    reveal(): void { this.panel.reveal(); }
    dispose(): void { this.panel.dispose(); }

    private show(): void {
        void this.panel.webview.postMessage({ type: 'plan', repo: this.repo,
            scope: this.plan.snapshot.scope === 'working' ? t('Working tree') : t('Staged changes'),
            drafts: this.plan.drafts.map(({ message, files }) => ({ message, files })),
            labels: {
                title: t('Review split commits'), sequence: t('Commit sequence'),
                message: t('Commit message'), changes: t('Changes'), files: t('Files'), cancel: t('Discard plan'),
                refine: t('Regroup with AI…'), apply: t('Create {0} commits…', this.plan.drafts.length),
                applyOne: t('Create commit…'), more: t('Show more lines'),
                expand: t('Expand all'), collapse: t('Collapse all'),
                unnamed: t('Untitled commit'), empty: t('Enter a commit message.'),
            } });
    }

    private async receive(action: { type?: string; messages?: unknown } | null): Promise<void> {
        if (!action || this.closed) { return; }
        if (action.type === 'ready') { this.show(); return; }
        if (this.busy) { return; }
        if (action.type === 'cancel') { this.dispose(); return; }
        if (action.type !== 'apply' && action.type !== 'refine') { return; }
        this.busy = true;
        try {
            if (action.type === 'refine') {
                const guidance = await vscode.window.showInputBox({ title: t('Regroup with AI…'),
                    prompt: t('Describe how to group the changes, or press Enter for a fresh plan.'),
                    placeHolder: t('Keep the cache fix and its tests together'), ignoreFocusOut: true });
                if (guidance === undefined || this.closed) { return; }
                const next = await this.regenerate(guidance);
                if (next && !this.closed) { this.plan = next; this.show(); }
                return;
            }
            const messages = action.messages;
            if (!Array.isArray(messages) || messages.length !== this.plan.drafts.length ||
                messages.some(m => typeof m !== 'string' || !m.trim() || m.includes('\0'))) {
                throw new Error(t('Each draft needs a valid commit message.'));
            }
            const drafts = this.plan.drafts.map((draft, i) => ({ ...draft, message: messages[i].trim() }));
            const button = t('Create commits');
            const choice = await vscode.window.showWarningMessage(t('Create the reviewed commits in {0}?', this.repo),
                { modal: true, detail: drafts.map((d, i) => (i + 1) + '. ' + d.message.split('\n')[0]).join('\n') }, button);
            if (choice !== button || this.closed) { return; }
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating reviewed commits…') },
                () => this.commit({ ...this.plan, drafts }));
            this.dispose();
            void vscode.window.showInformationMessage(t('Created {0} commits in {1}.', drafts.length, this.repo));
        } catch (err) {
            if (!this.closed) {
                void this.panel.webview.postMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
            }
        } finally {
            this.busy = false;
            if (!this.closed) { void this.panel.webview.postMessage({ type: 'idle' }); }
        }
    }
}
