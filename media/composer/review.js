import { el, button, modelButton } from './controls.js';
import { verification, refinement } from './feedback.js';
import { scopeView } from './scope.js';
import { fileDiff } from './diff.js';
import { changeSelection } from './selection.js';

const vscode = acquireVsCodeApi();
const root = document.getElementById('review');
let plan, active = 0, busy = false, scope, model, nav, detail, apply, actions, alert, split;
let selection, dragging, dropNew, move, refine;
const subject = draft => draft.message.trim().split('\n')[0] || plan.labels.unnamed;

function send(type, fields = {}) {
    if (busy) return;
    alert.hidden = true;
    if (type !== 'cancel') {
        busy = true;
        updateControls();
    }
    vscode.postMessage({type, from: active, revision: plan?.revision,
        messages: plan?.drafts.map(d => d.message), ...fields});
}
function updateControls() {
    root.setAttribute('aria-busy', String(busy));
    if (scope) {
        for (const node of scope.form.elements) node.disabled = busy;
        return;
    }
    for (const control of root.querySelectorAll('button, textarea, select, input')) control.disabled = busy;
    apply.disabled = busy || plan.drafts.some(d => !d.message.trim());
    const locked = !!plan.drafts[active].locked;
    move.disabled = busy || locked || !selection.ids.size;
    refine.disabled = busy || plan.drafts.every(d => d.locked);
    for (const node of detail.querySelectorAll('input[type=checkbox]')) node.disabled = busy || locked;
    split.disabled = busy || locked || !plan.drafts[active].canSplit;
}
function errorBox() {
    alert = el('div', 'error');
    alert.setAttribute('role','alert');
    alert.hidden = true;
    return alert;
}
function select(index, focus = false) {
    active = index;
    selection = changeSelection(() => { move.disabled = busy || !selection.ids.size; });
    nav.querySelectorAll('.draft').forEach((row, i) => {
        row.setAttribute('aria-current', String(i === index));
        row.tabIndex = i === index ? 0 : -1;
        if (focus && i === index) row.focus();
    });
    renderDetail();
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
function navRow(draft, index) {
    const row = button('', 'draft', () => select(index));
    row.title = draft.locked ? plan.labels.locked : plan.labels.dragDraft;
    const copy = el('span', 'draft-copy');
    const meta = el('span', 'meta', plan.labels.files + ' · ' + draft.files.length);
    if (draft.locked) meta.append(' · ', el('span', 'lock-state', plan.labels.locked));
    copy.append(el('span', 'subject', subject(draft)), meta);
    if (draft.check?.issues.length || draft.check?.skipped) row.classList.add('has-issues');
    row.append(el('span', 'ordinal', String(index + 1)), copy);
    row.addEventListener('keydown', event => {
        const delta = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[event.key];
        if (!delta || busy) return;
        event.preventDefault();
        select((index + delta + plan.drafts.length) % plan.drafts.length, true);
    });
    if (!draft.locked) drag(row, () => ({type: 'reorder', from: index}));
    drop(row, index);
    return row;
}
function draftMenu(labels) {
    const menu = el('select', 'draft-menu');
    menu.setAttribute('aria-label', labels.actions);
    menu.add(new Option(labels.actions, ''));
    menu.options[0].disabled = true;
    const add = (text, value, enabled = true) => {
        const option = new Option(text, value);
        option.disabled = !enabled;
        menu.add(option);
    };
    const free = !plan.drafts[active].locked;
    add(labels.reword, 'reword', free);
    add(labels.earlier, 'earlier', free && active > 0 && !plan.drafts[active - 1].locked);
    add(labels.later, 'later', free && active + 1 < plan.drafts.length && !plan.drafts[active + 1].locked);
    menu.value = '';
    menu.addEventListener('change', () => {
        const value = menu.value;
        menu.value = '';
        if (value === 'earlier' || value === 'later') send('reorder', {to: active + (value === 'earlier' ? -1 : 1)});
        else send(value);
    });
    return menu;
}
function renderDetail() {
    const draft = plan.drafts[active], l = plan.labels;
    detail.replaceChildren();
    const head = el('div', 'detail-head');
    split = button(l.split, 'text-button split-draft', () => send('split'));
    if (!draft.canSplit) split.title = l.indivisible;
    const lock = button(draft.locked ? l.unlock : l.lock, 'text-button lock-draft', () => send('lock'));
    lock.title = l.lockHint;
    lock.setAttribute('aria-pressed', String(!!draft.locked));
    head.append(el('span', 'counter', (active + 1) + ' / ' + plan.drafts.length), el('h2', '', l.message), lock, split, draftMenu(l));
    const input = el('textarea', 'message');
    input.setAttribute('aria-label', l.message);
    input.placeholder = l.empty;
    input.rows = Math.min(9, Math.max(3, draft.message.split('\n').length));
    input.value = draft.message;
    input.readOnly = !!draft.locked;
    input.addEventListener('input', () => {
        draft.message = input.value;
        nav.querySelectorAll('.subject')[active].textContent = subject(draft);
        updateControls();
    });
    const bar = el('div', 'changes-head');
    move = button(l.move, 'text-button', () => send('move', {edits: [...selection.ids]}));
    bar.append(el('h3', '', l.changes), el('span', 'count', draft.files.length), move);
    const files = el('div', 'files');
    for (const [i, file] of draft.files.entries()) {
        const box = el('div', 'file-box');
        const check = selection.checkbox(file.ids, l.selectFiles + ' · ' + file.path, 'file-select');
        const diff = fileDiff(file, i === 0, l, draft.locked ? undefined : selection);
        const summary = diff.querySelector('summary');
        if (!draft.locked) summary.title = l.dragFile;
        if (!draft.locked) drag(summary, () => ({type: 'move', from: active, edits: file.ids.some(id => selection.ids.has(id)) ? [...selection.ids] : file.ids}));
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
        bar.append(toggle);
    }
    detail.append(head, input, verification(draft.check, l), bar, files);
    detail.scrollTop = 0;
}
function renderPlan(data) {
    scope = undefined;
    plan = data;
    busy = false;
    const l = plan.labels;
    root.classList.remove('choosing-scope');
    const header = el('header');
    const title = el('div', 'heading');
    title.append(el('h1', '', l.title), el('div', 'repo', plan.repo + '  /  ' + plan.scope));
    model = modelButton(plan.model, l.model, () => send('model'));
    header.append(title, model);
    const layout = el('div', 'layout');
    const sidebar = el('aside');
    const heading = el('div', 'section-title');
    heading.append(el('h2', '', l.sequence), el('span', 'count', plan.drafts.length));
    nav = el('nav');
    nav.setAttribute('aria-label', l.sequence);
    nav.append(...plan.drafts.map(navRow));
    dropNew = el('div', 'new-draft-target', l.newDraft);
    dropNew.hidden = true;
    drop(dropNew, 'new');
    sidebar.append(heading, nav, dropNew);
    detail = el('section', 'detail');
    layout.append(sidebar, detail);
    actions = el('footer');
    apply = button(l.apply, 'primary', () => send('apply'));
    const close = () => { form.hidden = true; refine.setAttribute('aria-expanded', 'false'); refine.focus(); };
    const form = refinement(l, send, close);
    form.hidden = true;
    refine = button(l.refine, 'secondary', () => {
        form.hidden = !form.hidden;
        refine.setAttribute('aria-expanded', String(!form.hidden));
        if (!form.hidden) form.querySelector('textarea').focus();
    });
    if (plan.drafts.every(d => d.locked)) refine.title = l.allLocked;
    refine.setAttribute('aria-expanded', 'false');
    actions.append(form, button(l.cancel, 'text-button', () => send('cancel')), refine, apply);
    root.replaceChildren(header, layout, errorBox(), actions);
    if (data.warning) { alert.textContent = data.warning; alert.hidden = false; }
    select(data.active, true);
}
window.addEventListener('message', ({data}) => {
    if (data.type === 'scopes') {
        root.classList.add('choosing-scope');
        scope = scopeView(data, (type, fields) => {
            if (type === 'choose' || type === 'manual') scope.status.textContent = data.labels.pending;
            send(type, fields);
        }, action => vscode.postMessage(action));
        model = scope.model;
        root.replaceChildren(scope.form, errorBox());
        scope.form.querySelector('input:checked').focus();
    }
    if (data.type === 'files') scope?.showFiles(data);
    if (data.type === 'model' && model) {
        model.textContent = data.model || model.title;
        model.setAttribute('aria-label', model.title + (data.model ? ' · ' + data.model : ''));
    }
    if (data.type === 'plan') renderPlan(data);
    if (data.type === 'error') { alert.textContent = data.text; alert.hidden = false; }
    if (data.type === 'idle') { busy = false; if (scope) scope.status.textContent = ''; updateControls(); }
});
vscode.postMessage({type: 'ready'});
