import { l10n } from 'vscode';

const t = l10n.t;

function settingsLabels() {
    return { settings: t('Draft settings'), modelLabel: t('Split model'), model: t('Select a model') };
}

function progressLabels() {
    return {
        progressTitle: t('Prepare commit drafts'), cancel: t('Cancel'), cancelling: t('Cancelling…'),
        readingChanges: t('Reading selected changes…'), planningBranch: t('AI draft planning'), elapsed: t('Elapsed: {0}', '{0}'),
        steps: {
            changes: t('Read Git changes'), model: t('Select a split model'), analysis: t('Analyze dependencies'),
            analysisRetry: t('Retry change analysis'), grouping: t('Group changes by purpose'),
            groupingRetry: t('Retry draft grouping'),
        },
    };
}

export function scopeLabels() {
    return {
        ...settingsLabels(), ...progressLabels(), title: t('Commit drafts'), scope: t('Change scope'), files: t('Files'),
        guidance: t('Grouping instructions (optional)'), example: t('For example, separate the UI changes from the retry fix.'),
        compose: t('Generate drafts with AI'), manual: t('Group manually'),
        depth: t('Planning mode'), auto: t('Automatic'), quick: t('Quick · group in one round'), deep: t('Deep · analyze, group and order'),
        aiHint: t('Send the selected changes to the AI model.'), manualHint: t('Group changes locally without AI.'),
        pending: t('Preparing drafts…'), loading: t('Reading files…'), empty: t('No changes in the selected scope.'),
        status: { A: t('Added'), M: t('Modified'), D: t('Deleted'), R: t('Renamed'), C: t('Copied'), T: t('File type changed') },
    };
}

export function reviewLabels(count?: number) {
    return {
        ...settingsLabels(), ...progressLabels(), title: t('Review split commits'), sequence: t('Commit sequence'), message: t('Commit message'),
        changes: t('Changes'), files: t('Files'), refine: t('Refine with AI…'),
        apply: count === undefined || count === 1 ? t('Create commit…') : t('Create {0} commits…', count),
        lock: t('Lock draft'), unlock: t('Unlock draft'), locked: t('Locked'),
        lockHint: t('Keep this diff and message when refining other drafts.'),
        refineLabel: t('How should AI change the unlocked drafts?'), refineExample: t('For example, separate the UI changes from the retry fix.'),
        update: t('Update drafts'), back: t('Back to review'), checked: t('Checks run'), issues: t('New issues'),
        pendingCheck: t('Pending check'), checking: t('Checking…'), checkIncomplete: t('Check incomplete'),
        existing: t('Issues already present before these changes'), allLocked: t('Unlock a draft to continue.'),
        more: t('Show more lines'), expand: t('Expand all'), collapse: t('Collapse all'),
        unnamed: t('Untitled commit'), empty: t('Enter a commit message.'),
        split: t('Split this draft with AI…'), reword: t('Rewrite this message with AI'),
        earlier: t('Move draft earlier'), later: t('Move draft later'), move: t('Move selected changes…'),
        pickParts: t('Select part of this file'), fullDiff: t('View full diff'), block: t('Change block'), selectEdit: t('Select this edit'),
        moreEdits: t('Show more edits'), noNewline: t('No newline at end of file'),
        indivisible: t('This draft contains only one indivisible change.'), actions: t('Draft actions'), selectFiles: t('Select files to move'), newDraft: t('Move to new draft'),
        dragDraft: t('Drag to reorder this draft'), dragFile: t('Drag to move this file’s changes to another draft'),
    };
}
