import { el, button } from './controls.js';

export function verification(check, l) {
    const box = el('div', 'verification');
    if (!check) return box;
    box.append(el('span', '', l.checked + ' · ' + check.checks.join(' · ')));
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

export function refinement(l, send, close) {
    const form = el('form', 'refinement');
    const label = el('label', 'guidance-label', l.refineLabel);
    const input = el('textarea', 'guidance');
    input.id = 'refine-instructions';
    input.rows = 2;
    input.placeholder = l.refineExample;
    label.htmlFor = input.id;
    const actions = el('div', 'scope-actions');
    const submit = el('button', 'primary', l.update);
    submit.type = 'submit';
    actions.append(submit, button(l.close, 'text-button', close));
    form.append(label, input, actions);
    form.addEventListener('submit', event => { event.preventDefault(); send('refine', {guidance: input.value.trim()}); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); form.requestSubmit(); }
    });
    return form;
}

