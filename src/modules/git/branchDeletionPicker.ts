import * as vscode from 'vscode';
import type { BranchDeletion, RemoteDeletionTarget } from './GitService';

const t = vscode.l10n.t;
type Item = vscode.QuickPickItem & { toggleForce?: boolean; target?: RemoteDeletionTarget };
type Choice = { force: boolean; target?: RemoteDeletionTarget };

export function deletionItems({ branch, targets }: BranchDeletion, force: boolean): Item[] {
    let localDetail = t('Delete {0} in this repository.', branch.name);
    if (branch.upstream.startsWith('refs/heads/')) {
        localDetail = t('The upstream {0} is a local branch.', branch.upstream.slice('refs/heads/'.length));
    } else if (!targets.length) {
        localDetail = branch.upstream
            ? t('No fetched remote branch for upstream {0}.', branch.upstream.replace(/^refs\/remotes\//, ''))
            : t('No matching remote branch for {0} in the fetched refs.', branch.name);
    }
    return [
        {
            label: force ? t('Force delete local branch') : t('Delete local branch'),
            description: force ? '-D' : '-d', detail: localDetail,
        },
        ...targets.map(target => {
            const remoteName = target.remote + '/' + target.ref.slice('refs/heads/'.length);
            return {
                label: force ? t('Force delete local and remote branches') : t('Delete local and remote branches'),
                description: remoteName, target,
                detail: branch.upstream ? t('Also delete the upstream of {0}.', branch.name)
                    : t('Also delete the same-name branch on {0}.', target.remote),
            };
        }),
        { label: t('Options'), kind: vscode.QuickPickItemKind.Separator },
        {
            label: (force ? '$(check) ' : '$(circle-outline) ') + t('Force deletion'), description: '--force',
            detail: force ? t('On. Unmerged commits may be lost.') : t('Off. Enable to allow deleting unmerged commits.'),
            toggleForce: true,
        },
    ];
}

export async function pickBranchDeletion(plan: BranchDeletion): Promise<Choice | undefined> {
    const picker = vscode.window.createQuickPick<Item>();
    picker.title = t('Delete local branch {0}?', plan.branch.name);
    picker.placeholder = t('Choose what to delete');
    let force = false;
    picker.items = deletionItems(plan, force);
    try {
        return await new Promise<Choice | undefined>(resolve => {
            picker.onDidHide(() => resolve(undefined));
            picker.onDidAccept(() => {
                const [item] = picker.selectedItems;
                if (!item || item.kind === vscode.QuickPickItemKind.Separator) {
                    return;
                }
                if (item.toggleForce) {
                    force = !force;
                    picker.items = deletionItems(plan, force);
                    picker.activeItems = picker.items.filter(i => i.toggleForce);
                    return;
                }
                resolve({ force, target: item.target });
                picker.hide();
            });
            picker.show();
        });
    } finally {
        picker.dispose();
    }
}
