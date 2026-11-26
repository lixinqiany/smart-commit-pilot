import { el, button } from './controls.js';
import { generationProgress, verification, reviewActions } from './feedback.js';
import { disclosure, icon, settingsTool } from './panel-tools.js';
import { scopeView } from './scope.js';
import { fileDiff } from './diff.js';
import { changeSelection } from './selection.js';

const vscode = acquireVsCodeApi();
const root = document.getElementById('review');
let plan, active = 0, busy = false, scope, model, nav, detail, actions, alert, pending;
let selection, dragging, dropNew, move, rewordPreview = '';
let reviewSettings, draftCount, generation;
const fileCount = draft => draft.files?.length ?? draft.paths.length;
const subject = draft => draft.message.trim().split('\n')[0] || plan.labels.unnamed;

function send(type, fields = {}) {
    if (busy) return;
    alert.hidden = true;
    if (type !== 'cancel') {
        pending = type;
        busy = true;
        updateControls();
    }
    vscode.postMessage({type, from: active, revision: plan?.revision,
        messages: plan?.drafts.map(d => d.message), ...fields});
}
function updateControls() {
    root.setAttribute('aria-busy', String(busy && !generation));
    if (generation) return;
    if (scope) {
        scope.setBusy(busy);
        return;
    }
    for (const control of root.querySelectorAll('button, textarea, select, input')) control.disabled = busy || control.hasAttribute('data-unavailable');
    actions.update(busy, plan.drafts);
    const locked = !!plan.drafts[active].locked;
    move.disabled = busy || locked || !selection.ids.size;
    move.hidden = !selection.ids.size;
    for (const node of detail.querySelectorAll('input[type=checkbox]')) node.disabled = busy || locked;
}
function errorBox() {
    alert = el('div', 'error');
    alert.setAttribute('role','alert');
    alert.hidden = true;
    return alert;
}
function select(index, focus = false, previousDetail) {
    active = index;
    selection = changeSelection(updateControls);
    nav.querySelectorAll('.draft').forEach((row, i) => {
        row.setAttribute('aria-current', String(i === index));
        row.tabIndex = i === index ? 0 : -1;
        if (focus && i === index) row.focus();
    });
    renderDetail(previousDetail);
    updateControls();
}
function drag(node, payload) {
    node.draggable = true;
    node.addEventListener('dragstart', event => {
        if (busy) { event.preventDefault(); return; }
        dragging = payload();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', node.textContent);
        dropNew.hidden = dragging.type !== 'move';
    });
    node.addEventListener('dragend', endDrag);
}
function endDrag() {
    dragging = undefined;
    dropNew.hidden = true;
    root.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
}
function drop(node, to) {
    const accepts = () => dragging && dragging.from !== to && !busy && (to === 'new' ||
        !plan.drafts.slice(Math.min(dragging.from, to), Math.max(dragging.from, to) + 1).some(d => d.locked));
    node.addEventListener('dragover', event => {
        if (!accepts()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        node.classList.add('drop-target');
    });
    node.addEventListener('dragleave', event => {
        if (!node.contains(event.relatedTarget)) node.classList.remove('drop-target');
    });
    node.addEventListener('drop', event => {
        if (!accepts()) return;
        event.preventDefault();
        const payload = dragging;
        endDrag();
        send(payload.type, {...payload, to});
    });
}
function draftCheckText(draft) {
    const l = plan.labels;
    if (draft.check?.issues.length) return l.issues + ' · ' + draft.check.issues.length;
    if (draft.check?.skipped) return l.checkIncomplete;
    if (draft.check) return l.checked;
    if (generation) return draft.checking ? l.checking : l.pendingCheck;
    return '';
}
function updateDraftCheck(row, draft) {
    const text = draftCheckText(draft);
    const status = row.querySelector('.draft-check-state');
    status.textContent = text ? ' · ' + text : '';
    status.hidden = !text;
    row.classList.toggle('has-issues', Boolean(draft.check?.issues.length || draft.check?.skipped));
}
function draftVerification(draft) {
    if (!draft.check && generation) return el('div', 'verification', draftCheckText(draft));
    return verification(draft.check, plan.labels);
}

function navRow(draft, index) {
    const row = button('', 'draft', () => select(index));
    if (!generation) row.title = draft.locked ? plan.labels.locked : plan.labels.dragDraft;
    const copy = el('span', 'draft-copy');
    const meta = el('span', 'meta');
    meta.append(el('span', 'draft-file-count', plan.labels.files + ' · ' + fileCount(draft)));
    if (draft.locked) meta.append(' · ', el('span', 'lock-state', plan.labels.locked));
    meta.append(el('span', 'draft-check-state'));
    copy.append(el('span', 'subject', subject(draft)), meta);
    row.append(el('span', 'ordinal', String(index + 1)), copy);
    updateDraftCheck(row, draft);
    row.addEventListener('keydown', event => {
        const delta = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[event.key];
        if (!delta || (busy && !generation)) return;
        event.preventDefault();
        select((index + delta + plan.drafts.length) % plan.drafts.length, true);
    });
    if (!generation) {
        if (!draft.locked) drag(row, () => ({type: 'reorder', from: index}));
        drop(row, index);
    }
    return row;
}
function draftMenu(labels) {
    const tool = disclosure(labels.actions, 'more');
    const free = !plan.drafts[active].locked;
    function action(label, type, enabled, fields = {}) {
        const item = button(label, 'tool-action', () => { tool.close(); send(type, fields); });
        if (!enabled) item.setAttribute('data-unavailable', '');
        tool.panel.append(item);
        return item;
    }
    const split = action(labels.split, 'split', free && plan.drafts[active].canSplit);
    if (!plan.drafts[active].canSplit) split.title = labels.indivisible;
    action(labels.reword, 'reword', free);
    action(labels.earlier, 'reorder', free && active > 0 && !plan.drafts[active - 1].locked, {to: active - 1});
    action(labels.later, 'reorder', free && active + 1 < plan.drafts.length && !plan.drafts[active + 1].locked, {to: active + 1});
    return tool.root;
}
function saveDetail() {
    const openFiles = new Map([...detail.querySelectorAll('.file[data-path]')].map(file => [file.dataset.path, file.open]));
    return {openFiles, scrollTop: detail.scrollTop};
}
function renderDetail(previousDetail) {
    const draft = plan.drafts[active], l = plan.labels;
    detail.replaceChildren();
    if (!draft) return;

    const head = el('div', 'detail-head');
    head.append(el('h2', '', l.message));
    if (!generation) {
        const lock = button(draft.locked ? l.unlock : l.lock, 'lock-draft with-icon', () => send('lock'));
        lock.prepend(icon(draft.locked ? 'lock' : 'unlock'));
        lock.title = l.lockHint;
        lock.setAttribute('aria-pressed', String(!!draft.locked));
        head.append(lock, draftMenu(l));
    }
    const input = el('textarea', 'message');
    input.setAttribute('aria-label', l.message);
    input.placeholder = l.empty;
    input.rows = Math.min(9, Math.max(3, draft.message.split('\n').length));
    input.value = draft.message;
    input.readOnly = !!generation || !!draft.locked;
    input.addEventListener('input', () => {
        draft.message = input.value;
        nav.children[active].querySelector('.subject').textContent = subject(draft);
        updateControls();
    });
    const bar = el('div', 'changes-head');
    const fileActions = el('div', 'file-actions');
    if (!generation) {
        move = button(l.move, 'text-button', () => send('move', {edits: [...selection.ids]}));
        fileActions.append(move);
    }
    bar.append(el('h3', '', l.changes), el('span', 'count', fileCount(draft)), fileActions);
    detail.append(head, input, draftVerification(draft), bar);
    if (!draft.files) {
        const paths = el('ul', 'preview-paths');
        paths.append(...draft.paths.map(path => el('li', '', path)));
        detail.append(paths);
        detail.scrollTop = 0;
        return;
    }

    const files = el('div', 'files');
    for (const [i, file] of draft.files.entries()) {
        const editable = !generation;
        const diff = fileDiff(file, previousDetail?.openFiles.get(file.path) ?? i === 0, l,
            editable && !draft.locked ? selection : undefined);
        diff.dataset.path = file.path;
        if (!editable) {
            files.append(diff);
            continue;
        }
        const box = el('div', 'file-box');
        const check = selection.checkbox(file.ids, l.selectFiles + ' · ' + file.path, 'file-select');
        const summary = diff.querySelector('summary');
        if (!draft.locked) {
            summary.title = l.dragFile;
            drag(summary, () => ({type: 'move', from: active, edits: file.ids.some(id => selection.ids.has(id)) ? [...selection.ids] : file.ids}));
        }
        box.append(check, diff);
        files.append(box);
    }
    if (draft.files.length > 1) {
        const boxes = [...files.querySelectorAll('details')];
        const toggle = button('', 'text-button', () => {
            const expand = boxes.some(f => !f.open);
            boxes.forEach(f => { f.open = expand; });
        });
        const sync = () => { toggle.textContent = boxes.some(f => !f.open) ? l.expand : l.collapse; };
        sync();
        files.addEventListener('toggle', sync, true);
        fileActions.append(toggle);
    }
    detail.append(files);
    detail.scrollTop = previousDetail?.scrollTop ?? 0;
}
function renderLayout(data, footer) {
    const l = data.labels;
    root.classList.remove('choosing-scope', 'waiting-for-draft');
    const header = el('header');
    const title = el('div', 'heading');
    title.append(el('h1', '', l.title), el('div', 'repo', [data.product, data.repo, data.scope].filter(Boolean).join(' · ')));
    const settings = settingsTool(data, () => send('model'));
    reviewSettings = settings.root;
    reviewSettings.hidden = !!generation;
    model = settings.model;
    header.append(title, reviewSettings);

    const layout = el('div', 'layout');
    const sidebar = el('aside');
    const heading = el('div', 'section-title');
    draftCount = el('span', 'count');
    heading.append(el('h2', '', l.sequence), draftCount);
    nav = el('nav');
    nav.setAttribute('aria-label', l.sequence);
    dropNew = el('div', 'new-draft-target', l.newDraft);
    dropNew.hidden = true;
    drop(dropNew, 'new');
    sidebar.append(heading, nav, dropNew);
    detail = el('section', 'detail');
    layout.append(sidebar, detail);
    root.replaceChildren(header, layout, errorBox(), footer);
}
function showDrafts(index, focus, previousDetail) {
    draftCount.textContent = String(plan.drafts.length);
    nav.replaceChildren(...plan.drafts.map(navRow));
    select(index, focus, previousDetail);
}
function renderPlan(data) {
    const fromGeneration = generation?.reviewing;
    const previousActions = pending === 'refine' ? undefined : actions?.state;
    const selectedId = fromGeneration ? plan.drafts[active]?.id : undefined;
    const sameDraft = selectedId === undefined ? -1 : data.drafts.findIndex(draft => draft.id === selectedId);
    const previousDetail = sameDraft < 0 ? undefined : saveDetail();
    generation?.dispose();
    generation = undefined;
    scope = undefined;
    plan = data;
    busy = false;
    actions = reviewActions(data.labels, send, fromGeneration ? undefined : previousActions, data.elapsedMs);
    if (fromGeneration) {
        root.querySelector('footer').replaceWith(actions.root);
        reviewSettings.hidden = false;
    } else {
        renderLayout(data, actions.root);
    }
    if (data.warning) { alert.textContent = data.warning; alert.hidden = false; }
    showDrafts(sameDraft < 0 ? data.active : sameDraft, true, previousDetail);
}
function showWaiting(labels) {
    generation = generationProgress(labels, () => vscode.postMessage({type: 'stopGeneration'}));
    generation.setStatus(labels.readingChanges, 'changes', 0);
    const panel = el('section', 'generation-waiting');
    const card = el('div', 'generation-waiting-card');
    card.append(el('h1', '', labels.progressTitle), generation.trace, generation.root);
    panel.append(card);
    root.classList.remove('choosing-scope');
    root.classList.add('waiting-for-draft');
    root.replaceChildren(panel, alert);
    updateControls();
    generation.cancel.focus({preventScroll: true});
}
function showGeneratingReview() {
    if (generation.reviewing || generation.cancel.disabled || !plan.drafts.length) return;
    generation.reviewing = true;
    const restoreFocus = document.activeElement === generation.cancel;
    const footer = el('footer', 'generation-footer');
    footer.append(generation.root);
    renderLayout(plan, footer);
    showDrafts(0, false);
    if (restoreFocus) generation.cancel.focus({preventScroll: true});
}
function startGeneration(data) {
    plan = data;
    busy = true;
    if (!generation) showWaiting(data.labels);
    generation.syncElapsed(data.elapsedMs);
    for (const status of data.steps ?? []) generation.setStatus(status.text, status.step, status.at - data.startedAt);
    generation.setStatus(data.status);
    showGeneratingReview();
}
function updateGeneration(event) {
    if (event.type === 'status') {
        generation.setStatus(event.text, event.step, plan ? event.at - plan.startedAt : undefined);
    } else if (event.type === 'append') {
        const index = plan.drafts.length;
        plan.drafts.push(event.draft);
        if (!generation.reviewing) {
            showGeneratingReview();
            return;
        }
        const row = navRow(event.draft, index);
        row.tabIndex = -1;
        nav.append(row);
        draftCount.textContent = String(plan.drafts.length);
        if (!index) select(0);
    } else if (event.type === 'diff') {
        const draft = plan.drafts[event.index];
        draft.files = event.files;
        nav.children[event.index].querySelector('.draft-file-count').textContent = plan.labels.files + ' · ' + fileCount(draft);
        if (event.index === active) renderDetail(saveDetail());
    } else if (event.type === 'check') {
        const draft = plan.drafts[event.index];
        draft.checking = !event.result;
        draft.check = event.result;
        updateDraftCheck(nav.children[event.index], draft);
        if (event.index === active) detail.querySelector('.verification').replaceWith(draftVerification(draft));
    } else if (event.type === 'replace') {
        if (!generation.reviewing) {
            plan.drafts = event.drafts;
            showGeneratingReview();
            return;
        }
        const previous = plan.drafts[active];
        const selected = previous ? event.drafts.findIndex(draft => draft.id === previous.id) : -1;
        const previousDetail = selected < 0 ? undefined : saveDetail();
        const focus = nav.contains(document.activeElement);
        plan.drafts = event.drafts;
        showDrafts(Math.max(0, selected), focus, previousDetail);
    }
}
window.addEventListener('message', ({data}) => {
    if (data.type === 'scopes') {
        generation?.dispose();
        generation = undefined;
        plan = undefined;
        root.classList.remove('waiting-for-draft');
        root.classList.add('choosing-scope');
        scope = scopeView(data, (type, fields) => {
            if (type === 'manual') scope.status.textContent = data.labels.pending;
            send(type, fields);
            if (type === 'choose') showWaiting(data.labels);
        }, action => vscode.postMessage(action));
        model = scope.model;
        root.replaceChildren(scope.form, errorBox());
        scope.title.focus({preventScroll: true});
    }
    if (data.type === 'generation') startGeneration(data);
    if (data.type === 'progress' && generation) updateGeneration(data.event);
    if (data.type === 'files') scope?.showFiles(data);
    if (data.type === 'model') {
        if (generation && plan) plan.model = data.model;
        for (const control of new Set([model, scope?.model])) {
            if (!control) continue;
            control.textContent = data.model || control.title;
            control.setAttribute('aria-label', control.title + (data.model ? ' · ' + data.model : ''));
        }
    }
    if (data.type === 'rewordText' && pending === 'reword' && data.revision === plan?.revision && data.index === active) {
        rewordPreview += data.delta;
        detail.querySelector('.message').value = rewordPreview;
    }
    if (data.type === 'plan') renderPlan(data);
    if (data.type === 'error') { alert.textContent = data.text; alert.hidden = false; }
    if (data.type === 'idle') {
        if (pending === 'reword') {
            detail.querySelector('.message').value = plan.drafts[active].message;
            rewordPreview = '';
        }
        pending = undefined;
        busy = false;
        const interrupted = !!generation;
        if (interrupted && scope) {
            generation.dispose();
            generation = undefined;
            plan = undefined;
            model = scope.model;
            root.classList.remove('waiting-for-draft');
            root.classList.add('choosing-scope');
            root.replaceChildren(scope.form, alert);
        }
        if (scope) scope.status.textContent = '';
        updateControls();
        if (interrupted) scope?.focusGenerate();
    }
});
vscode.postMessage({type: 'ready'});
