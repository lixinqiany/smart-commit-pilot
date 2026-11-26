import { l10n } from 'vscode';
import { Usage } from './unified-protocols/response';

export function logTokenUsage(usage: Usage | null, log: (message: string) => void): void {
    if (!usage) { return; }
    const t = l10n.t;
    log(t('Token usage: {0} input, {1} output.', usage.input_tokens, usage.output_tokens));
    const details = usage.input_tokens_details;
    if ('cache_write_tokens' in details) {
        log(t('Prompt cache tokens: {0} read, {1} written.',
            details.cached_tokens ?? t('not reported'), details.cache_write_tokens ?? t('not reported')));
    } else if ('cache_creation_input_tokens' in details) {
        log(t('Prompt cache tokens: {0} read, {1} written.',
            details.cache_read_input_tokens ?? t('not reported'), details.cache_creation_input_tokens ?? t('not reported')));
    }
}
