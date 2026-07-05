export const DEFAULT_BASE_URLS: Record<string, string> = {
    OpenAI: 'https://api.openai.com/v1',
    Anthropic: 'https://api.anthropic.com',
};

export const DEFAULT_COMMIT_PROMPT = `Format:
<type>(<scope>): <subject>

<body>

<footer>

Rules:
- type: lowercase, required, one of: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test
- scope: optional; describes the module or file the change is confined to
- subject: required; not sentence-case, Start Case, PascalCase, or UPPERCASE; no trailing period; terse and in imperative mood
- header (the entire first line "type(scope): subject") must not exceed 100 characters
- body: optional; omit entirely (including its blank line) when the subject alone conveys the reasoning; otherwise separate it from the header with exactly one blank line and wrap each line at 100 characters
- footer: optional; omit entirely (including its blank line) when not needed; otherwise separate it from what precedes it with exactly one blank line and wrap each line at 100 characters; used e.g. for "BREAKING CHANGE: ..." or issue references
- for breaking changes, append "!" after the type/scope and explain the break in a "BREAKING CHANGE:" footer
- Output ONLY the commit message text — no explanations, no markdown, no code fences`;

export enum Venders {
    OpenAI = 'OpenAI',
    Anthropic = 'Anthropic'
}