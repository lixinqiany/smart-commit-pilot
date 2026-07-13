# Smart Git Pilot

Generate AI-powered commit messages and inspect current-line Git history directly in VS Code.

## Features

- **One-click generation** — click the Smart Git Pilot icon in the Source Control panel's title bar and it writes a commit message straight into the commit input box.
- **Bring your own provider** — works with either OpenAI or Anthropic. You supply the API key and base URL, so it also works with OpenAI/Anthropic-compatible proxies and self-hosted gateways.
- **Conventional Commits by default** — the built-in prompt asks the model for a `type(scope): subject` header plus body/footer, validated against `@commitlint/config-conventional` rules (lowercase type, 100-char line wraps, `BREAKING CHANGE:` footer handling, etc.).
- **Customizable prompt** — override the default instructions with your own house style via a single setting.
- **Secure credentials** — your API key is stored in VS Code's encrypted secret storage, never written to `settings.json`.
- **Model picker** — fetches the live list of models available to your account/provider and lets you pick one, instead of hardcoding a model name.
- **Current line blame** — shows the author, relative time, and commit summary for the active line, with full details and a copyable hash on hover. Local edits are marked as uncommitted without losing history for unchanged lines.

## Requirements

- The built-in **Git** extension (`vscode.git`) must be enabled — Smart Git Pilot reads staged changes and repository history through it.
- An API key for one of the supported providers:
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/settings/keys)
- A git repository open in the workspace with at least one staged change.

## Getting Started

1. Open the Command Palette and run **Smart Git Pilot: Setup Provider**.
   - Pick OpenAI or Anthropic, confirm/edit the base URL, and paste your API key.
   - You'll immediately be asked to pick a model — this list is fetched live from your provider.
2. Stage the changes you want to commit (`git add` or the Source Control panel).
3. Click the **Generate Commit Message** icon in the Source Control panel's title bar.
4. Review the generated message in the commit input box, edit if needed, and commit as usual.

You can re-run **Setup Provider** or **Select Model** any time to switch providers or models.

## Extension Settings

| Setting | Description |
|---|---|
| `smartCommitPilot.provider` | Selected LLM vendor: `OpenAI` or `Anthropic`. |
| `smartCommitPilot.baseUrl` | Base URL used to reach the selected provider (supports compatible proxies/gateways). |
| `smartCommitPilot.model` | Model used to generate commit messages, chosen via **Select Model**. |
| `smartCommitPilot.prompt` | Custom instructions appended to the commit-message prompt. Leave empty to use the built-in Conventional Commits template. |
| `smartCommitPilot.blame.enabled` | Shows commit information for the current editor line. Enabled by default. |
| `smartCommitPilot.blame.avatars` | Shows Gravatar or generated cartoon avatars in blame hovers. Enabled by default. |

Your API key is **not** stored in this list — it lives in VS Code's secret storage and is set via **Setup Provider**.

When blame avatars are enabled, Smart Git Pilot derives a Gravatar URL from the commit author's email address and VS Code may request that remote image. Disable `smartCommitPilot.blame.avatars` to use a local editor icon instead.

## Commands

| Command | What it does |
|---|---|
| `Smart Git Pilot: Setup Provider` | Configure provider, base URL, and API key; then prompts you to select a model. |
| `Smart Git Pilot: Select Model` | Re-fetch and choose a model for the currently configured provider. |
| `Smart Git Pilot: Setup Prompt` | Opens the `smartCommitPilot.prompt` instructions in a multi-line editor; save (Cmd/Ctrl+S) to apply. |
| `Smart Git Pilot: Generate Commit Message` | Generates a commit message from staged changes (also available as the icon in the Source Control title bar). |
| `Smart Git Pilot: Toggle Current Line Blame` | Enables or disables the current-line commit hint for the workspace. |

## Known Issues

- Requires at least one staged change — Smart Git Pilot won't generate a message from unstaged or working-tree changes.
- Very large diffs may be truncated or produce lower-quality messages depending on the selected model's context window.
- Current line blame requires the Git executable configured for VS Code, or `git` available on your PATH.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

**Enjoy!**
