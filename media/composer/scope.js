import { el, button, modelButton } from './controls.js';

export function scopeView(data, send, requestFiles) {
    const labels = data.labels;
    const form = el('form', 'scope-picker');
    const title = el('h1', '', labels.title);
    const model = modelButton(data.model, labels.model, () => send('model'));
    const heading = el('div', 'scope-heading');
    const project = el('div');
    project.append(title, el('div', 'repo', data.repo));
    heading.append(project, model);
    const fieldset = el('fieldset', 'scope-fields');
    fieldset.append(el('legend', '', labels.scope));
    const list = el('div', 'scope-options');
    let selected = data.choices[0].scope, request = 0;
    const preview = el('details', 'scope-preview');
    const summary = el('summary', '', labels.preview);
    const output = el('div', 'scope-file-list');
    output.setAttribute('aria-live', 'polite');
    function readFiles() {
        if (!preview.open) return;
        output.textContent = labels.loading;
        requestFiles({type: 'files', scope: selected, request: ++request});
    }
    preview.addEventListener('toggle', readFiles);
    preview.append(summary, output);
    function showFiles(reply) {
        if (reply.request !== request) return;
        if (reply.error || !reply.paths.length) { output.textContent = reply.error || labels.empty; return; }
        const list = el('ul');
        for (const path of reply.paths) list.append(el('li', '', path));
        output.replaceChildren(list);
    }
    for (const choice of data.choices) {
        const row = el('label', 'scope-option');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = 'scope';
        radio.value = choice.scope;
        radio.checked = choice.scope === selected;
        radio.addEventListener('change', () => { selected = choice.scope; readFiles(); });
        const copy = el('span', 'scope-copy');
        copy.append(el('span', 'scope-title', choice.title), el('small', 'scope-detail', choice.detail));
        row.append(radio, copy);
        list.append(row);
    }
    fieldset.append(list);
    const guidance = el('textarea', 'guidance');
    guidance.rows = 2;
    guidance.id = 'grouping-instructions';
    guidance.placeholder = labels.example;
    const label = el('label', 'guidance-label', labels.guidance);
    label.htmlFor = guidance.id;
    const depthLabel = el('label', 'depth-choice', labels.depth);
    const depth = el('select', 'draft-menu');
    for (const [value, caption] of [['auto', labels.auto], ['quick', labels.quick], ['deep', labels.deep]]) {
        depth.add(new Option(caption, value));
    }
    depthLabel.append(depth);
    const actions = el('div', 'scope-actions');
    const start = type => send(type, {scope: selected, guidance: guidance.value.trim(), depth: depth.value});
    const generate = el('button', 'primary', labels.compose);
    generate.type = 'submit';
    actions.append(generate, button(labels.manual, 'secondary', () => start('manual')));
    form.addEventListener('submit', event => { event.preventDefault(); start('choose'); });
    form.addEventListener('keydown', event => {
        if (event.key === 'Escape') send('cancel');
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); start('choose'); }
    });
    const status = el('div', 'scope-status');
    status.setAttribute('role', 'status');
    form.append(heading, fieldset, preview, label, guidance, el('p', 'scope-detail', labels.privacy), depthLabel, actions, status);
    return { form, model, status, showFiles };
}
