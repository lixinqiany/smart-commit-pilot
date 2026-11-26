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

function elapsedText(milliseconds) {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    return [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

const planningSteps = new Set(['analysis', 'analysisRetry', 'grouping', 'groupingRetry']);

export function generationProgress(labels, stop) {
    const root = el('div', 'generation-progress');
    const indicator = el('span', 'generation-indicator');
    indicator.setAttribute('aria-hidden', 'true');
    const status = el('span', 'generation-status');
    status.setAttribute('role', 'status');
    const trace = el('ol', 'generation-trace');
    const totalTime = el('span', 'generation-elapsed');
    let startedAt = performance.now(), current, branch;
    const elapsed = () => performance.now() - startedAt;
    const cancel = button(labels.cancel, 'secondary', () => {
        cancel.disabled = true;
        status.textContent = labels.cancelling;
        if (current) current.detail.textContent = labels.cancelling;
        if (branch) branch.detail.textContent = labels.cancelling;
        stop();
    });
    root.append(indicator, status, totalTime, cancel);

    function updateTimes() {
        const duration = elapsed();
        totalTime.textContent = labels.elapsed.replace('{0}', elapsedText(duration));
        if (view.reviewing) return;
        if (current) current.time.textContent = elapsedText(duration - current.at);
        if (branch) branch.time.textContent = elapsedText(duration - branch.at);
    }

    function makeMarker() {
        const marker = el('span', 'generation-step-marker');
        marker.setAttribute('aria-hidden', 'true');
        marker.append(el('span', 'generation-indicator'));
        return marker;
    }

    function startBranch(at) {
        const row = el('li', 'generation-branch');
        const disclosure = el('details', 'generation-branch-details');
        disclosure.open = true;
        const summary = el('summary', 'generation-branch-summary');
        const marker = makeMarker();
        const heading = el('span', 'generation-branch-heading');
        const chevron = el('span', 'chevron');
        chevron.setAttribute('aria-hidden', 'true');
        heading.append(chevron, el('strong', '', labels.planningBranch));
        const detail = el('span', 'generation-branch-detail');
        const content = el('span', 'generation-step-content');
        content.append(heading, detail);
        const time = el('span', 'generation-step-elapsed');
        summary.append(marker, content, time);
        const children = el('ol', 'generation-children');
        disclosure.append(summary, children);
        row.append(disclosure);
        trace.append(row);
        return {at, marker, detail, time, children};
    }

    function setStep(step, text, at) {
        if (step === 'analysis' && !branch) branch = startBranch(at);
        const grouped = branch && planningSteps.has(step);
        if (grouped) branch.detail.textContent = text;
        if (current?.step === step) {
            current.detail.textContent = text;
            return;
        }
        if (current) {
            current.row.removeAttribute('aria-current');
            current.marker.replaceChildren(icon('check'));
            current.detail.hidden = current.detail.textContent === current.startedWith;
            current.time.textContent = elapsedText(at - current.at);
        }
        if (!grouped && branch) {
            branch.marker.replaceChildren(icon('check'));
            branch.detail.hidden = true;
            branch.time.textContent = elapsedText(at - branch.at);
            branch = undefined;
        }

        const row = el('li', 'generation-step');
        row.setAttribute('aria-current', 'step');
        const marker = makeMarker();
        const label = el('strong', '', labels.steps[step]);
        const detail = el('div', 'generation-step-detail', text);
        const content = el('div', 'generation-step-content');
        content.append(label, detail);
        const time = el('span', 'generation-step-elapsed');
        row.append(marker, content, time);
        (branch?.children ?? trace).append(row);
        current = {step, at, row, marker, detail, time, startedWith: text};
        updateTimes();
    }
    const view = {
        root, trace, cancel, reviewing: false,
        syncElapsed(milliseconds) {
            if (Number.isFinite(milliseconds)) startedAt = Math.min(startedAt, performance.now() - milliseconds);
            updateTimes();
        },
        setStatus(text, step, at) {
            if (cancel.disabled) return;
            if (status.textContent !== text) status.textContent = text;
            if (step && !view.reviewing) setStep(step, text, Number.isFinite(at) ? at : elapsed());
        },
        dispose() { window.clearInterval(timer); },
    };
    const timer = window.setInterval(updateTimes, 1000);
    updateTimes();
    return view;
}

export function reviewActions(l, send, previous, elapsedMs) {
    const root = el('footer');
    const toolbar = el('div', 'review-actions');
    const refine = button(l.refine, 'secondary with-icon', () => showForm(true));
    refine.prepend(icon('compose'));
    const apply = button(l.apply, 'primary', () => send('apply'));
    if (Number.isFinite(elapsedMs)) {
        toolbar.append(el('span', 'review-elapsed', l.elapsed.replace('{0}', elapsedText(elapsedMs))));
    }
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
