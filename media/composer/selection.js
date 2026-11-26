import { button, el } from './controls.js';

// Whole files, blocks and individual replacements share one set of edit IDs.
export function changeSelection(onChange) {
    const ids = new Set();
    const controls = [];
    function sync(input, members) {
        let count = 0;
        for (const id of members) if (ids.has(id)) count++;
        input.checked = count === members.length;
        input.indeterminate = count > 0 && count < members.length;
    }
    function checkbox(members, label, cls) {
        const input = el('input', cls);
        input.type = 'checkbox';
        input.setAttribute('aria-label', label);
        controls.push([input, members]);
        sync(input, members);
        input.addEventListener('change', () => {
            for (const id of members) {
                if (input.checked) ids.add(id);
                else ids.delete(id);
            }
            for (const [node, bound] of controls) sync(node, bound);
            onChange();
        });
        return input;
    }
    return {ids, checkbox};
}

function range(start, count) {
    return (count ? start + 1 : start) + ',' + count;
}

function segment(lines, sign, start, labels) {
    const side = el('div', sign === '+' ? 'add edit-side' : 'del edit-side');
    const numbers = [], text = [];
    for (const [i, line] of lines.entries()) {
        numbers.push(String(start + i));
        text.push(sign + ' ' + line.replace(/\r?\n$/, ''));
        if (!line.endsWith('\n')) { numbers.push(''); text.push('↳ ' + labels.noNewline); }
    }
    side.append(el('span', 'gutter', numbers.join('\n')), el('code', '', text.join('\n')));
    return side;
}

// Build controls on demand and page long additions. A block checkbox also
// selects the edits on pages the user has not expanded yet.
export function blockPicker(file, selection, labels) {
    const picker = el('div', 'block-picker');
    const blocks = el('div');
    let blockIndex = 0, unitIndex = 0, body, oldLine, newLine;
    const more = button(labels.moreEdits, 'more', renderPage);
    function renderPage() {
        let budget = 80;
        while (budget > 0 && blockIndex < file.blocks.length) {
            const block = file.blocks[blockIndex];
            const name = labels.block + ' ' + (blockIndex + 1);
            if (unitIndex === 0) {
                const section = el('section', 'change-block');
                const heading = el('label', 'block-head');
                const members = block.units.map(unit => unit.id);
                heading.append(selection.checkbox(members, file.path + ' · ' + name, 'block-select'), el('strong', '', name),
                    el('code', 'block-range', '−' + range(block.oldStart, block.removed) + ' +' + range(block.newStart, block.added)));
                body = el('div', 'block-units');
                section.append(heading, body);
                blocks.append(section);
                oldLine = block.oldStart + 1;
                newLine = block.newStart + 1;
            }
            const unit = block.units[unitIndex++];
            const row = el('div', 'edit-unit');
            if (block.units.length > 1) {
                const location = unit.removed.length ? '−' + oldLine : '+' + newLine;
                row.append(selection.checkbox([unit.id], labels.selectEdit + ' · ' + file.path + ' · ' + location, 'unit-select'));
            }
            const code = el('div', 'edit-code');
            if (unit.removed.length) code.append(segment(unit.removed, '−', oldLine, labels));
            if (unit.added.length) code.append(segment(unit.added, '+', newLine, labels));
            row.append(code);
            body.append(row);
            oldLine += unit.removed.length;
            newLine += unit.added.length;
            budget--;
            if (unitIndex === block.units.length) { blockIndex++; unitIndex = 0; }
        }
        more.hidden = blockIndex === file.blocks.length;
    }
    picker.append(blocks, more);
    renderPage();
    return picker;
}
