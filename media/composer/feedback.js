import { el, button } from './controls.js';
import { icon } from './panel-tools.js';

export function verification(check, l) {
    const box = el('div', 'verification');
    if (!check) return box;
    const status = el('span', 'check-summary');
    if (!check.skipped && !check.issues.length) status.append(icon('check'));
    status.append([l.checked, ...check.checks].join(' · '));
    box.append(status);
    if (check.existing) box.append(el('span', 'meta', l.existing + ' · ' + check.existing));
    if (check.skipped) box.append(el('div', 'check-warning', check.skipped));
    if (check.issues.length) {
        const detail = el('details', 'check-warning');
        detail.open = true;
        detail.append(el('summary', '', l.issues + ' · ' + check.issues.length));
        const list = el('ul');
        for (const issue of check.issues) {
            const location = issue.file ? issue.file + (issue.line ? ':' + issue.line : '') + ' · ' : '';
            list.append(el('li', '', location + issue.code + ' ' + issue.message));
        }
        detail.append(list);
        box.append(detail);
    }
    return box;
}

export function reviewActions(l, send, previous) {
    const root = el('footer');
    const toolbar = el('div', 'review-actions');
    const refine = button(l.refine, 'secondary with-icon', () => showForm(true));
    refine.prepend(icon('compose'));
    const apply = button(l.apply, 'primary', () => send('apply'));
    toolbar.append(refine, apply);

    const form = el('form', 'refinement');
    form.id = 'refinement';
    refine.setAttribute('aria-controls', form.id);
    const label = el('label', 'guidance-label', l.refineLabel);
    label.prepend(icon('compose'));
    const input = el('textarea', 'scope-input');
    input.id = label.htmlFor = 'refine-instructions';
    input.rows = 2;
    input.placeholder = l.refineExample;
    input.value = previous?.text ?? '';
    const actions = el('div', 'refinement-actions');
    const submit = el('button', 'primary', l.update);
    submit.type = 'submit';
    actions.append(button(l.back, 'compose-manual', () => showForm(false)), submit);
    form.append(label, input, actions);
    root.append(toolbar, form);

    function showForm(open, focus = true) {
        form.hidden = !open;
        toolbar.hidden = open;
        refine.setAttribute('aria-expanded', String(open));
        if (focus) (open ? input : refine).focus();
    }
    showForm(!!previous?.open, false);
    form.addEventListener('submit', event => { event.preventDefault(); send('refine', {guidance: input.value.trim()}); });
    form.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); showForm(false); }
        if (event.target === input && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            form.requestSubmit();
        }
    });
    return {
        root,
        get state() { return {open: !form.hidden, text: input.value}; },
        update(busy, drafts) {
            const allLocked = drafts.every(d => d.locked);
            if (allLocked && !form.hidden) showForm(false, false);
            refine.title = allLocked ? l.allLocked : '';
            refine.disabled = busy || allLocked;
            apply.disabled = busy || drafts.some(d => !d.message.trim());
        },
    };
}
