import { el, button } from './controls.js';
import { icon, settingsTool } from './panel-tools.js';

function fileRow(file, labels) {
    const slash = file.path.lastIndexOf('/');
    const row = el('li', 'scope-file');
    row.title = file.previousPath ? file.previousPath + ' → ' + file.path : file.path;
    const name = el('span', 'scope-file-name', file.path.slice(slash + 1));
    const status = el('span', 'file-status', file.status);
    status.dataset.status = file.status;
    status.setAttribute('aria-label', labels[file.status] ?? file.status);
    status.title = labels[file.status] ?? file.status;
    row.append(icon('files'), name);
    if (slash >= 0) row.append(el('span', 'scope-file-dir', file.path.slice(0, slash)));
    row.append(status);
    return row;
}

export function scopeView(data, send, postMessage) {
    const l = data.labels;
    let selected = data.choices[0].scope, depth = 'auto', request = 0, busy = false, empty = false;
    const form = el('form', 'scope-picker');
    const title = el('h1', '', l.title);
    title.tabIndex = -1;
    const settings = settingsTool(data, () => send('model'), value => { depth = value; });
    const heading = el('div', 'scope-heading');
    const repo = el('div', 'scope-repo');
    repo.append(el('span', '', data.product));
    if (data.repo) repo.append(icon('repo'), el('span', '', data.repo));
    const project = el('div');
    project.append(title, repo);
    heading.append(project, settings.root);

    const sources = el('fieldset', 'scope-sources');
    sources.append(el('legend', 'pane-label', l.scope));
    for (const choice of data.choices) {
        const row = el('label', 'scope-option');
        const radio = el('input', 'sr-only');
        radio.type = 'radio';
        radio.name = 'scope';
        radio.value = choice.scope;
        radio.checked = choice.scope === selected;
        radio.addEventListener('change', () => { selected = choice.scope; readFiles(); });
        const copy = el('span', 'scope-copy');
        copy.append(el('span', 'scope-title', choice.title), el('small', 'scope-description', choice.detail));
        row.append(radio, copy, icon('check'));
        sources.append(row);
    }
    const preview = el('section', 'scope-preview');
    const caption = el('h2', 'pane-label', l.files);
    const count = el('span', 'file-count');
    caption.append(count);
    const list = el('ul', 'scope-file-list');
    list.tabIndex = 0;
    list.setAttribute('aria-label', l.files);
    const notice = el('div', 'scope-notice');
    notice.setAttribute('role', 'status');
    preview.append(caption, list, notice);
    function readFiles() {
        empty = false;
        setBusy(busy);
        count.textContent = '';
        list.replaceChildren();
        list.hidden = true;
        notice.textContent = l.loading;
        postMessage({type: 'files', scope: selected, request: ++request});
    }
    function showFiles(reply) {
        if (reply.request !== request) return;
        const files = reply.files ?? [];
        empty = !reply.error && !files.length;
        count.textContent = reply.error ? '' : String(files.length);
        notice.textContent = reply.error || (empty ? l.empty : '');
        list.hidden = !files.length;
        list.replaceChildren(...files.map(file => fileRow(file, l.status)));
        setBusy(busy);
    }
    const changes = el('div', 'scope-panes');
    changes.append(sources, preview);

    const composer = el('div', 'scope-composer');
    const label = el('label', 'pane-label', l.guidance);
    const guidance = el('textarea', 'scope-input');
    guidance.id = label.htmlFor = 'grouping-instructions';
    guidance.rows = 2;
    guidance.placeholder = l.example;
    const actions = el('div', 'compose-actions');
    const generate = el('button', 'primary compose-primary');
    generate.type = 'submit';
    generate.append(icon('compose'), el('span', '', l.compose));
    generate.title = l.aiHint;
    generate.setAttribute('aria-description', l.aiHint);
    const manual = button(l.manual, 'compose-manual', () => start('manual'));
    manual.title = l.manualHint;
    manual.setAttribute('aria-description', l.manualHint);
    actions.append(manual, generate);
    composer.append(label, guidance, actions);

    function start(type) {
        if (!busy && !empty) send(type, {scope: selected, guidance: guidance.value.trim(), depth});
    }
    function setBusy(value) {
        busy = value;
        for (const node of form.elements) node.disabled = busy;
        manual.disabled = generate.disabled = busy || empty;
    }
    form.addEventListener('submit', event => { event.preventDefault(); start('choose'); });
    form.addEventListener('keydown', event => {
        if (event.key === 'Escape') send('cancel');
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); start('choose'); }
    });
    const status = el('div', 'scope-status');
    status.setAttribute('role', 'status');
    form.append(heading, changes, composer, status);
    readFiles();
    return { form, model: settings.model, title, status, showFiles, setBusy,
        focusGenerate: () => generate.focus({preventScroll: true}),
    };
}
