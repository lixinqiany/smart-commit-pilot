// Runs in a VS Code webview. Repository data is only inserted as text.
(() => {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('review');
    let plan, active = 0, busy = false;
    let nav, detail, apply, alert, controls;
    const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    function button(label, cls, click) {
        const node = el('button', cls, label);
        node.type = 'button';
        node.addEventListener('click', click);
        return node;
    }
    function send(type) {
        if (busy) return;
        if (type !== 'cancel') {
            busy = true;
            updateActions();
        }
        vscode.postMessage({type, messages: plan.drafts.map(d => d.message)});
    }
    function updateActions() {
        for (const control of controls.querySelectorAll('button')) control.disabled = busy;
        apply.disabled = busy || plan.drafts.some(d => !d.message.trim());
        detail.querySelector('textarea').disabled = busy;
        root.setAttribute('aria-busy', String(busy));
    }
    function subject(draft) {
        return draft.message.trim().split('\n')[0] || plan.labels.unnamed;
    }
    function select(index, focus = false) {
        active = index;
        nav.querySelectorAll('button').forEach((row, i) => {
            row.setAttribute('aria-current', String(i === active));
            row.tabIndex = i === active ? 0 : -1;
            if (focus && i === active) row.focus();
        });
        renderDetail();
        updateActions();
    }
    function navRow(draft, index) {
        const row = button('', 'draft', () => select(index));
        const copy = el('span', 'draft-copy');
        copy.append(el('span', 'subject', subject(draft)), el('span', 'meta', plan.labels.files + ' · ' + draft.files.length));
        row.append(el('span', 'ordinal', String(index + 1)), copy);
        row.addEventListener('keydown', event => {
            const delta = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[event.key];
            if (!delta) return;
            event.preventDefault();
            select((index + delta + plan.drafts.length) % plan.drafts.length, true);
        });
        return row;
    }
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
    function fileDiff(file, first) {
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
        const more = button(plan.labels.more, 'more', renderPage);
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
        fileBox.append(scroll, more);
        fileBox.addEventListener('toggle', () => { if (fileBox.open && !rendered) renderPage(); });
        fileBox.open = first;
        return fileBox;
    }
    function renderDetail() {
        const draft = plan.drafts[active], labels = plan.labels;
        detail.replaceChildren();
        const head = el('div', 'detail-head');
        head.append(el('span', 'counter', (active + 1) + ' / ' + plan.drafts.length), el('h2', '', labels.message));
        const input = el('textarea', 'message');
        input.setAttribute('aria-label', labels.message);
        input.placeholder = labels.empty;
        input.rows = Math.min(9, Math.max(3, draft.message.split('\n').length));
        input.value = draft.message;
        input.addEventListener('input', () => {
            draft.message = input.value;
            nav.querySelectorAll('.subject')[active].textContent = subject(draft);
            input.setAttribute('aria-invalid', String(!input.value.trim()));
            updateActions();
        });
        const bar = el('div', 'changes-head');
        bar.append(el('h3', '', labels.changes), el('span', 'count', draft.files.length));
        const files = el('div', 'files');
        files.append(...draft.files.map((f,i) => fileDiff(f, i === 0)));
        if (draft.files.length > 1) {
            const toggle = button('', 'text-button', () => {
                const boxes = [...files.querySelectorAll('details')];
                const expand = boxes.some(f => !f.open);
                boxes.forEach(f => { f.open = expand; });
            });
            const sync = () => { toggle.textContent = [...files.querySelectorAll('details')].some(f => !f.open) ? labels.expand : labels.collapse; };
            sync();
            files.addEventListener('toggle', sync, true);
            bar.append(toggle);
        }
        detail.append(head, input, bar, files);
        detail.scrollTop = 0;
    }
    function render() {
        const l = plan.labels;
        root.replaceChildren();
        const header = el('header');
        const icon = el('span', 'mark', '⑂');
        icon.setAttribute('aria-hidden','true');
        const title = el('div', 'heading');
        title.append(el('h1', '', l.title), el('div', 'repo', plan.repo + '  /  ' + plan.scope));
        header.append(icon,title);
        const layout = el('div', 'layout');
        const sidebar = el('aside');
        const heading = el('div', 'section-title');
        heading.append(el('h2', '', l.sequence), el('span', 'count', plan.drafts.length));
        nav = el('nav');
        nav.setAttribute('aria-label', l.sequence);
        nav.append(...plan.drafts.map(navRow));
        sidebar.append(heading,nav);
        detail = el('section', 'detail');
        layout.append(sidebar,detail);
        alert = el('div', 'error');
        alert.setAttribute('role','alert');
        alert.hidden = true;
        controls = el('footer');
        const discard = button(l.cancel, 'text-button', () => send('cancel'));
        const refine = button(l.refine, 'secondary', () => send('refine'));
        apply = button(plan.drafts.length === 1 ? l.applyOne : l.apply, 'primary', () => send('apply'));
        controls.append(discard,refine,apply);
        root.append(header,layout,alert,controls);
        select(0);
    }
    window.addEventListener('message', ({data}) => {
        if (data.type === 'plan') { plan = data; busy = false; render(); }
        if (data.type === 'error') { alert.textContent = data.text; alert.hidden = false; }
        if (data.type === 'idle') { busy = false; updateActions(); }
    });
    vscode.postMessage({type:'ready'});
})();
