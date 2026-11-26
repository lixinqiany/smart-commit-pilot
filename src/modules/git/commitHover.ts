import * as vscode from 'vscode';
import { authorAvatar } from './authorAvatar';
import { COPY_BLAME_HASH_COMMAND } from './BlameRunner';
import { formatRelativeTime } from './formatRelativeTime';
import type { CommitHoverDetails, HistoryCommit } from './GitService';

const t = vscode.l10n.t;
const viewCommit = 'git.viewCommit';

function text(card: vscode.MarkdownString, value: string): void {
    const plain = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // appendText escapes Markdown but makes every space nonbreaking. Let prose wrap in narrow hovers.
    const escaped = new vscode.MarkdownString('', true).appendText(plain).value;
    card.appendMarkdown(escaped.replace(/&nbsp;/g, ' '));
}

function link(command: string, args: unknown[]): string {
    const query = encodeURIComponent(JSON.stringify(args)).replace(/\(/g, '%28').replace(/\)/g, '%29');
    return 'command:' + command + '?' + query;
}

function timeLabel(date: Date): string {
    const absolute = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'long', timeStyle: 'short' }).format(date);
    return formatRelativeTime(date) + ' (' + absolute + ')';
}

function coloredStat(kind: 'added' | 'modified' | 'deleted', label: string): string {
    return '<span style="color:var(--vscode-gitDecoration-' + kind + 'ResourceForeground);">' + label + '</span>';
}

function appendChangeStats(card: vscode.MarkdownString, { files, additions, deletions }: CommitHoverDetails): void {
    const { added, modified, deleted } = files;
    if (added + modified + deleted === 0) {
        return;
    }
    const badges = [coloredStat('added', '+' + added), coloredStat('modified', '~' + modified), coloredStat('deleted', '-' + deleted)];
    card.appendMarkdown(' &nbsp; <span style="background-color:var(--vscode-textCodeBlock-background);">&nbsp;' +
        badges.join(' ') + '&nbsp;</span> ');
    const changedFiles = [
        added && (added === 1 ? t('1 file added') : t('{0} files added', added)),
        modified && (modified === 1 ? t('1 file changed') : t('{0} files changed', modified)),
        deleted && (deleted === 1 ? t('1 file deleted') : t('{0} files deleted', deleted)),
    ].filter(Boolean);
    text(card, '(' + changedFiles.join(', ') + ')');
    const lines = [
        additions && coloredStat('added', additions === 1 ? t('1 addition') : t('{0} additions', additions)),
        deletions && coloredStat('deleted', deletions === 1 ? t('1 deletion') : t('{0} deletions', deletions)),
    ].filter(Boolean);
    if (lines.length) {
        card.appendMarkdown(' &nbsp;' + lines.join(', '));
    }
}

export function commitHover(repo: vscode.Uri, commit: HistoryCommit, details: CommitHoverDetails | undefined,
    showAvatar: boolean, canInspect: boolean): vscode.MarkdownString {
    const card = new vscode.MarkdownString('', true);
    card.supportHtml = true;
    card.isTrusted = { enabledCommands: canInspect ? [viewCommit, COPY_BLAME_HASH_COMMAND] : [COPY_BLAME_HASH_COMMAND] };
    const avatar = showAvatar ? authorAvatar(commit.authorEmail, 64) : undefined;
    card.appendMarkdown(avatar ? '![](' + avatar.toString(true) + '|width=32,height=32) ' : '$(account) ');
    card.appendMarkdown('**');
    text(card, commit.author || t('Unknown author'));
    card.appendMarkdown('** &nbsp; $(history) ');
    const authoredAt = details?.authoredAt ?? commit.date;
    text(card, timeLabel(authoredAt));
    if (authoredAt.getTime() !== commit.date.getTime()) {
        card.appendMarkdown('  \n');
        text(card, t('Committed {0}', timeLabel(commit.date)));
    }
    const short = commit.hash.slice(0, 7);
    const copy = link(COPY_BLAME_HASH_COMMAND, [commit.hash]);
    card.appendMarkdown('  \n');
    if (canInspect) {
        card.appendMarkdown('[$(git-commit) ' + short + '](' + link(viewCommit, [repo, commit.hash]) + ' "' + t('Open commit changes') + '")');
    } else {
        card.appendMarkdown('$(git-commit) `' + short + '`');
    }
    if (details) {
        appendChangeStats(card, details);
    }
    card.appendMarkdown(' [$(copy)](' + copy + ' "' + t('Copy full commit hash') + '")');
    card.appendMarkdown('\n\n');
    const message = details?.message || commit.subject || t('Untitled commit');
    for (const [i, line] of message.split(/\r?\n/).entries()) {
        if (i) {
            card.appendMarkdown('  \n');
        }
        text(card, line);
    }
    return card;
}
