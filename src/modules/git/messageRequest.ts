import { MessageCreationRequest, MessageRole } from '../adaptor/unified-protocols/request';

const PROMPT_PREFIX =
    'You are a commit message generator. Given a git diff of staged changes, write a single commit message following the Conventional Commits specification, validated against @commitlint/config-conventional rules.';

export function messageRequest(model: string, diff: string, convention: string): MessageCreationRequest {
    return { model, avoidCacheWrites: true, max_output_tokens: 1024, system: PROMPT_PREFIX + '\n\n' + convention,
        messages: [{ role: MessageRole.USER, content: diff }] };
}
