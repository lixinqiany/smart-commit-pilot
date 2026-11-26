import { el, button } from './controls.js';
import { blockPicker } from './selection.js';

function parsePatch(patch) {
    const rows = [];
    let before = 0, after = 0, inHunk = false, adds = 0, dels = 0;
    for (const line of patch.replace(/\n$/, '').split('\n')) {
        const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (range) { before = +range[1]; after = +range[2]; inHunk = true; }
        if (!inHunk && /^(diff --git |index |--- |\+\+\+ )/.test(line)) continue;
        const kind = !inHunk || range || line[0] === '\\' ? 'info' :
            line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'context';
        if (kind === 'add') adds++;
        if (kind === 'del') dels++;
        rows.push([kind, kind === 'del' || kind === 'context' ? before++ : '',
            kind === 'add' || kind === 'context' ? after++ : '', line]);
    }
    return {rows, adds, dels};
}
export function fileDiff(file, first, labels, selection) {
    const {rows, adds, dels} = parsePatch(file.patch);
    const fileBox = el('details', 'file');
    const title = el('summary');
    title.append(el('span', 'chevron'), el('span', 'filepath', file.path));
    if (adds || dels) title.append(el('span', 'plus', '+' + adds), el('span', 'minus', '−' + dels));
    fileBox.append(title);
    let rendered = 0;
    const scroll = el('div', 'diff-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('aria-label', file.path);
    const code = el('div', 'code');
    scroll.append(code);
    const more = button(labels.more, 'more', renderPage);
    function renderPage() {
        const fragment = document.createDocumentFragment();
        for (const [kind, before, after, text] of rows.slice(rendered, rendered + 200)) {
            const row = el('div', 'line ' + kind);
            row.append(el('span', 'gutter', before), el('span', 'gutter', after), el('code', '', text));
            fragment.append(row);
        }
        rendered += 200;
        code.append(fragment);
        more.hidden = rendered >= rows.length;
    }
    const patch = el('div');
    patch.append(scroll, more);
    if (selection && file.blocks?.length) {
        let picker;
        const toolbar = el('div', 'diff-tools');
        const toggle = button(labels.pickParts, 'text-button', () => {
            if (!picker) {
                picker = blockPicker(file, selection, labels);
                fileBox.append(picker);
            }
            patch.hidden = !patch.hidden;
            picker.hidden = !patch.hidden;
            toggle.textContent = patch.hidden ? labels.fullDiff : labels.pickParts;
            toggle.setAttribute('aria-pressed', String(patch.hidden));
        });
        toggle.setAttribute('aria-pressed', 'false');
        toolbar.append(toggle);
        fileBox.append(toolbar);
    }
    fileBox.append(patch);
    fileBox.addEventListener('toggle', () => { if (fileBox.open && !rendered) renderPage(); });
    fileBox.open = first;
    return fileBox;
}
