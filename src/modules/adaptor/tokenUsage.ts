import type { Usage } from './unified-protocols/response';

export interface TokenBreakdown {
    uncachedInput: number | null;
    cacheWrite: number | null;
    cacheRead: number | null;
    output: number | null;
}

function count(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function tokenUsage(usage: Usage | null): { tokens: TokenBreakdown; totalTokens: number | null; reportedTokens: number } {
    const details = usage?.input_tokens_details;
    const input = count(usage?.input_tokens);
    const output = count(usage?.output_tokens);
    if (details && 'cached_tokens' in details) {
        const cacheRead = count(details.cached_tokens);
        const cacheWrite = count(details.cache_write_tokens);
        // OpenAI reports the two cache buckets as subsets of input_tokens.
        const uncachedInput = input === null || cacheRead === null || cacheWrite === null
            ? null : count(input - cacheRead - cacheWrite);
        return {
            tokens: { uncachedInput, cacheWrite, cacheRead, output },
            totalTokens: input === null || output === null ? null : input + output,
            reportedTokens: (input ?? ((cacheWrite ?? 0) + (cacheRead ?? 0))) + (output ?? 0),
        };
    }

    // Anthropic reports uncached input and both cache buckets separately.
    const creation = details?.cache_creation;
    const cacheWrite = count(details?.cache_creation_input_tokens) ??
        (creation ? count(creation.ephemeral_1h_input_tokens + creation.ephemeral_5m_input_tokens) : null);
    const cacheRead = count(details?.cache_read_input_tokens);
    const tokens = { uncachedInput: input, cacheWrite, cacheRead, output };
    const reportedTokens = (input ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0) + (output ?? 0);
    const totalTokens = Object.values(tokens).includes(null) ? null : reportedTokens;
    return { tokens, totalTokens, reportedTokens };
}
