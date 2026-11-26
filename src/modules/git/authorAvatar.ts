import { createHash } from 'node:crypto';
import { Uri } from 'vscode';

export function authorAvatar(email: string | undefined, pixels: number): Uri | undefined {
    const identity = email?.trim().toLowerCase();
    if (!identity) {
        return undefined;
    }
    if (identity === 'noreply@github.com') {
        return Uri.parse('https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png');
    }
    const github = /^(?:(\d+)\+)?([a-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/.exec(identity);
    if (github) {
        const account = github[1] ? 'u/' + github[1] : encodeURIComponent(github[2]);
        return Uri.parse('https://avatars.githubusercontent.com/' + account + '?size=' + pixels);
    }
    const hash = createHash('md5').update(identity).digest('hex');
    return Uri.parse('https://www.gravatar.com/avatar/' + hash + '?s=' + pixels + '&d=robohash');
}
