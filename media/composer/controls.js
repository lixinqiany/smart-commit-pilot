export const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
};
export function button(label, cls, click) {
    const node = el('button', cls, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
}

export function modelButton(model, label, click) {
    const node = button(model || label, 'model-button', click);
    node.setAttribute('aria-label', label + (model ? ' · ' + model : ''));
    node.title = label;
    return node;
}
