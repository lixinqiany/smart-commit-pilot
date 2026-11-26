import * as vscode from 'vscode';
import { authorAvatar } from './authorAvatar';
import { Configurator } from '../configuration/Configurator';
import { displayLocale, formatRelativeTime } from './formatRelativeTime';
import { BlameInfo, GitService } from './GitService';

export const COPY_BLAME_HASH_COMMAND = 'smart-commit-pilot.copyBlameHash';

const BLAME_DELAY_MS = 300;
const t = vscode.l10n.t;
const MAX_INLINE_SUMMARY_LENGTH = 80;

interface CachedBlame {
    key: string;
    value: BlameInfo | undefined;
}

export class BlameRunner implements vscode.Disposable {
    readonly #decorationType = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            margin: '0 0 0 3em',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    readonly #disposables: vscode.Disposable[] = [];
    #timer: NodeJS.Timeout | undefined;
    #abortController: AbortController | undefined;
    #requestVersion = 0;
    #lastEditor: vscode.TextEditor | undefined;
    #cache: CachedBlame | undefined;

    constructor(
        private readonly gitService: GitService,
        private readonly configurator: Configurator
    ) {}

    start(): void {
        this.#disposables.push(
            vscode.window.onDidChangeTextEditorSelection((event) => this.#schedule(event.textEditor)),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this.#clear();
                if (editor) {
                    this.#schedule(editor);
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const editor = vscode.window.activeTextEditor;
                if (editor && event.document === editor.document) {
                    this.#cache = undefined;
                    this.#schedule(editor);
                }
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (!event.affectsConfiguration('smartCommitPilot.blame.enabled')) {
                    return;
                }
                if (!this.configurator.isLineBlameEnabled()) {
                    this.#cancelPending();
                    this.#clear();
                    return;
                }
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    this.#schedule(editor);
                }
            })
        );

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.#schedule(editor);
        }
    }

    dispose(): void {
        this.#cancelPending();
        this.#clear();
        this.#decorationType.dispose();
        for (const disposable of this.#disposables) {
            disposable.dispose();
        }
    }

    #schedule(editor: vscode.TextEditor): void {
        this.#cancelPending();
        this.#clear();

        if (!this.configurator.isLineBlameEnabled() || !this.#canBlame(editor)) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            void this.#update(editor);
        }, BLAME_DELAY_MS);
    }

    async #update(editor: vscode.TextEditor): Promise<void> {
        if (editor !== vscode.window.activeTextEditor || !this.#canBlame(editor)) {
            return;
        }

        const line = editor.selection.active.line;
        const documentVersion = editor.document.version;
        const cacheKey = `${editor.document.uri.toString()}\0${editor.document.version}\0${line}`;
        const requestVersion = ++this.#requestVersion;
        this.#abortController = new AbortController();

        const blame = this.#cache?.key === cacheKey
            ? this.#cache.value
            : await this.gitService.getLineBlame(
                editor.document.uri,
                line,
                editor.document.getText(),
                this.#abortController.signal
            );

        if (requestVersion !== this.#requestVersion || editor !== vscode.window.activeTextEditor) {
            return;
        }
        if (editor.selection.active.line !== line || editor.document.version !== documentVersion) {
            return;
        }

        this.#cache = { key: cacheKey, value: blame };
        if (!blame) {
            this.#clear();
            return;
        }

        this.#render(editor, line, blame);
    }

    #render(editor: vscode.TextEditor, line: number, blame: BlameInfo): void {
        const lineText = editor.document.lineAt(line);
        const range = new vscode.Range(lineText.range.start, lineText.range.end);
        const decoration: vscode.DecorationOptions = {
            range,
            hoverMessage: this.#formatHover(blame),
            renderOptions: {
                after: {
                    contentText: this.#formatInline(blame),
                },
            },
        };

        editor.setDecorations(this.#decorationType, [decoration]);
        this.#lastEditor = editor;
    }

    #formatInline(blame: BlameInfo): string {
        if (blame.isUncommitted) {
            return t('You • Uncommitted changes');
        }

        const author = blame.isCurrentUser ? t('You') : blame.author;
        const summary = blame.summary.length > MAX_INLINE_SUMMARY_LENGTH
            ? `${blame.summary.slice(0, MAX_INLINE_SUMMARY_LENGTH - 1)}…`
            : blame.summary;
        return `${author}, ${formatRelativeTime(blame.authoredAt)} • ${summary}`;
    }

    #formatHover(blame: BlameInfo): vscode.MarkdownString {
        const markdown = new vscode.MarkdownString(undefined, true);
        markdown.supportHtml = true;
        markdown.isTrusted = { enabledCommands: [COPY_BLAME_HASH_COMMAND] };

        if (blame.isUncommitted) {
            const avatar = formatAvatar(blame.authorEmail, t('You'), this.configurator.isLineBlameAvatarEnabled());
            const author = formatAuthorLink(t('You'), blame.authorEmail);
            markdown.appendMarkdown(`${avatar} ${author} &nbsp; $(history) ${t('Uncommitted changes')}\n\n`);
            markdown.appendMarkdown(t('This line has local changes that have not been committed.'));
            return markdown;
        }

        const authorName = blame.isCurrentUser ? t('You') : blame.author;
        const author = formatAuthorLink(authorName, blame.authorEmail);
        const avatar = formatAvatar(blame.authorEmail, authorName, this.configurator.isLineBlameAvatarEnabled());
        const authoredAt = new Intl.DateTimeFormat(displayLocale, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(blame.authoredAt);
        const relativeTime = formatRelativeTime(blame.authoredAt);
        const shortHash = blame.hash.slice(0, 7);
        const commandArgs = encodeURIComponent(JSON.stringify([blame.hash]));

        markdown.appendMarkdown(
            `${avatar} ${author} &nbsp; $(history) ${escapeMarkdown(relativeTime)} _(${escapeMarkdown(authoredAt)})_\n\n`
        );
        markdown.appendMarkdown(`${escapeMarkdown(blame.summary)}\n\n`);
        markdown.appendMarkdown(`\`${shortHash}\` · [$(copy) ${t('Copy hash')}](command:${COPY_BLAME_HASH_COMMAND}?${commandArgs})`);
        return markdown;
    }

    #canBlame(editor: vscode.TextEditor): boolean {
        return editor.document.uri.scheme === 'file'
            && editor.document.lineCount > 0
            && editor.selection.active.line < editor.document.lineCount;
    }

    #cancelPending(): void {
        if (this.#timer) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }
        this.#abortController?.abort();
        this.#abortController = undefined;
        this.#requestVersion += 1;
    }

    #clear(): void {
        this.#lastEditor?.setDecorations(this.#decorationType, []);
        this.#lastEditor = undefined;
    }
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}

function formatAuthorLink(author: string, email?: string): string {
    const label = escapeMarkdown(author);
    if (!email) {
        return `[**${label}**](# "${label}")`;
    }

    const title = t('Email {0} ({1})', author, email).replace(/"/g, '\\"');
    return `[**${label}**](mailto:${encodeURIComponent(email)} "${title}")`;
}

function formatAvatar(email: string | undefined, author: string, enabled: boolean): string {
    if (!enabled || !email) {
        return '$(account)';
    }

    const title = escapeMarkdown(author);
    const uri = authorAvatar(email, 64)?.toString(true);
    if (!uri) {
        return '$(account)';
    }
    return `![${title}](${uri}|width=32,height=32 "${title}")`;
}
