import { el, button, modelButton } from './controls.js';

// Monochrome line icons inherit the VS Code theme and use the same 16px grid as SCM.
const paths = {
    settings: 'M2 4h5m3 0h4M2 12h2m3 0h7 M10 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0 M7 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0',
    lock: 'M4 7h8v7H4z M5.5 7V5a2.5 2.5 0 1 1 5 0v2 M8 9.5v2',
    unlock: 'M4 7h8v7H4z M5.5 7V5a2.5 2.5 0 0 1 5-.5 M8 9.5v2',
    more: 'M3 8h.1m4.9 0h.1m4.9 0h.1',
    repo: 'M4 2h9v12H4a1.5 1.5 0 0 1 0-3h9 M2.5 12.5v-9A1.5 1.5 0 0 1 4 2 M6 4.5h4',
    files: 'M3.5 2h6l3 3v9h-9z M9.5 2v3.5h3 M5.5 8h5m-5 2.5h4',
    check: 'M3 8l3 3 7-7',
    compose: 'M3 11.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0 M5.6 10.4l3.2-3.2 M11.5 1.5l.9 2.5 2.6 1-2.6.9-.9 2.6-.9-2.6L8 5l2.6-1z',
};
export function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', paths[name]);
    path.setAttribute('stroke-width', name === 'more' ? '2.3' : '1.3');
    svg.append(path);
    return svg;
}

let visible;
document.addEventListener('pointerdown', event => {
    if (visible && !visible.root.contains(event.target)) visible.close(false);
});

export function disclosure(label, glyph) {
    const root = el('div', 'panel-tool');
    const panel = el('div', 'tool-popup');
    panel.hidden = true;
    const trigger = button('', 'tool-trigger', () => {
        if (!panel.hidden) { close(true); return; }
        visible?.close(false);
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        visible = {root, close};
    });
    trigger.append(icon(glyph));
    trigger.title = label;
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-expanded', 'false');
    function close(focus = true) {
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (visible?.root === root) visible = undefined;
        if (focus) trigger.focus();
    }
    root.addEventListener('focusout', event => {
        if (event.relatedTarget && !root.contains(event.relatedTarget)) close(false);
    });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) {
            event.stopPropagation();
            event.preventDefault();
            close();
        }
    });
    root.append(trigger, panel);
    return { root, trigger, panel, close };
}

export function settingsTool(data, selectModel, onDepth) {
    const l = data.labels;
    const tool = disclosure(l.settings, 'settings');
    const model = modelButton(data.model, l.model, () => { tool.close(); selectModel(); });
    const row = el('div', 'setting-model');
    row.append(el('span', 'tool-label', l.modelLabel), model);
    tool.panel.append(row);
    if (onDepth) {
        const modes = el('fieldset', 'setting-modes');
        modes.append(el('legend', 'tool-label', l.depth));
        modes.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); tool.close(); }
        });
        for (const [value, title] of [['auto', l.auto], ['quick', l.quick], ['deep', l.deep]]) {
            const choice = el('label', 'setting-option');
            const radio = el('input', 'sr-only');
            radio.type = 'radio';
            radio.name = 'depth';
            radio.value = value;
            radio.checked = value === 'auto';
            radio.addEventListener('change', () => onDepth(value));
            choice.append(radio, el('span', '', title), icon('check'));
            modes.append(choice);
        }
        tool.panel.append(modes);
    }
    return { root: tool.root, model };
}
