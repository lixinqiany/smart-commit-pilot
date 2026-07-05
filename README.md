# SmartCommitPilot

Generate Conventional-Commits-style commit messages from your staged changes, powered by OpenAI or Anthropic — right from the Source Control panel.

## Features

- **One-click generation** — click the sparkle (✨) icon in the Source Control panel's title bar and SmartCommitPilot writes a commit message straight into the commit input box.
- **Bring your own provider** — works with either OpenAI or Anthropic. You supply the API key and base URL, so it also works with OpenAI/Anthropic-compatible proxies and self-hosted gateways.
- **Conventional Commits by default** — the built-in prompt asks the model for a `type(scope): subject` header plus body/footer, validated against `@commitlint/config-conventional` rules (lowercase type, 100-char line wraps, `BREAKING CHANGE:` footer handling, etc.).
- **Customizable prompt** — override the default instructions with your own house style via a single setting.
- **Secure credentials** — your API key is stored in VS Code's encrypted secret storage, never written to `settings.json`.
- **Model picker** — fetches the live list of models available to your account/provider and lets you pick one, instead of hardcoding a model name.

## Requirements

- The built-in **Git** extension (`vscode.git`) must be enabled — SmartCommitPilot reads staged changes through it.
- An API key for one of the supported providers:
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/settings/keys)
- A git repository open in the workspace with at least one staged change.

## Getting Started

1. Open the Command Palette and run **Smart Commit Pilot: Setup Provider**.
   - Pick OpenAI or Anthropic, confirm/edit the base URL, and paste your API key.
   - You'll immediately be asked to pick a model — this list is fetched live from your provider.
2. Stage the changes you want to commit (`git add` or the Source Control panel).
3. Click the ✨ **Generate Commit Message** icon in the Source Control panel's title bar.
4. Review the generated message in the commit input box, edit if needed, and commit as usual.

You can re-run **Setup Provider** or **Select Model** any time to switch providers or models.

## Extension Settings

| Setting | Description |
|---|---|
| `smartCommitPilot.provider` | Selected LLM vendor: `OpenAI` or `Anthropic`. |
| `smartCommitPilot.baseUrl` | Base URL used to reach the selected provider (supports compatible proxies/gateways). |
| `smartCommitPilot.model` | Model used to generate commit messages, chosen via **Select Model**. |
| `smartCommitPilot.prompt` | Custom instructions appended to the commit-message prompt. Leave empty to use the built-in Conventional Commits template. |

Your API key is **not** stored in this list — it lives in VS Code's secret storage and is set via **Setup Provider**.

## Commands

| Command | What it does |
|---|---|
| `Smart Commit Pilot: Setup Provider` | Configure provider, base URL, and API key; then prompts you to select a model. |
| `Smart Commit Pilot: Select Model` | Re-fetch and choose a model for the currently configured provider. |
| `Smart Commit Pilot: Setup Prompt` | Opens Settings focused on `smartCommitPilot.prompt` so you can customize the instructions. |
| `Smart Commit Pilot: Generate Commit Message` | Generates a commit message from staged changes (also available as the ✨ icon in the Source Control title bar). |

## Known Issues

- Requires at least one staged change — SmartCommitPilot won't generate a message from unstaged or working-tree changes.
- Very large diffs may be truncated or produce lower-quality messages depending on the selected model's context window.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

**Enjoy!**
