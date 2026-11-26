# Smart Git Pilot

Manage Git branches, inspect current-line history, and generate AI-powered commit messages in VS Code.

## Features

- **One-click generation** — click the Smart Git Pilot icon in the Source Control panel's title bar and it writes a commit message straight into the commit input box.
- **Bring your own provider** — works with either OpenAI or Anthropic. You supply the API key and base URL, so it also works with OpenAI/Anthropic-compatible proxies and self-hosted gateways.
- **Conventional Commits by default** — the built-in prompt asks the model for a `type(scope): subject` header plus body/footer, validated against `@commitlint/config-conventional` rules (lowercase type, 100-char line wraps, `BREAKING CHANGE:` footer handling, etc.).
- **Customizable prompt** — override the default instructions with your own house style via a single setting.
- **Secure credentials** — your API key is stored in VS Code's encrypted secret storage, never written to `settings.json`.
- **Model picker** — fetches the live list of models available to your account/provider and lets you pick one, instead of hardcoding a model name.
- **Current line blame** — shows the author, relative time, and commit summary for the active line, with full details and a copyable hash on hover. Local edits are marked as uncommitted without losing history for unchanged lines.

## Branches

Open **Source Control → Smart Git Pilot**. The two icons beside the view title select local branches (three connected dots) or remotes (cloud). The active icon has an underline. Each workspace remembers the last view and the local branch layout.

- **Branches (N)** shows a flat list of full local branch names by default. Hover or focus the count row and select **View as Tree** to group other branches by slash-separated prefixes. A shared path such as `feature/mobile` appears as one folder. Select **View as List** to return to the flat list. The count row also offers switch, create (**+**), and refresh actions. The checked-out branch stays first and uses a branch icon with solid nodes and a **Current** label, even when another row is hovered.
- **Remotes (N)** is a fixed heading. Each remote, such as `origin`, starts collapsed. Expand it to see fetched branches by their full name within that remote, such as `feature/login`. Empty remotes appear as plain rows. The heading’s **+** adds a remote by name and URL. Use **Git: Fetch** to retrieve remote refs.
- Expand a local or remote branch to browse its commits. Expand a commit to see the files it changed, then select a file to compare that revision with its first parent. Select **Show more commits…** for older history.
- Commit rows show the author’s avatar. Hover a commit to see its full message and dates. Next to the short hash, `+`, `~`, and `-` count added, modified, and deleted files. The following figures count lines added and deleted. Copy the full hash from the card or select the short hash to open the changes in VS Code versions with the built-in commit viewer.
- Groups of up to five changed files show filenames with their directories beside them. Larger groups expand into folders. Each file’s badge shows its status in that commit.
- Hover or right-click a branch for **Switch**, **Fetch** (cloud with a down arrow), and **Create From Here** (**+**). Switch is disabled on the current branch. Switching to a remote branch reuses a local tracking branch or offers to create one. Fetch updates the selected remote-tracking ref and leaves local commits and working files in place. On a local branch, Fetch uses its configured upstream and is disabled when there is no remote upstream.
- In multi-repository workspaces the count row and its actions belong to the repository shown above it.

## Requirements

- The built-in **Git** extension (`vscode.git`) must be enabled — Smart Git Pilot reads staged changes and repository history through it.
- Branch operations require Git 2.23 or later and an open repository.
- AI commit generation requires staged changes and an API key for one of the supported providers:
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/settings/keys)

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
| `smartCommitPilot.blame.avatars` | Shows author avatars in branch history and blame hovers. Enabled by default. |

Your API key is **not** stored in this list — it lives in VS Code's secret storage and is set via **Setup Provider**.

With avatars enabled, VS Code can request an image from GitHub for a GitHub noreply identity or from Gravatar using a hash of the author’s email. Gravatar supplies a RoboHash robot when the author has no profile image. Turning off `smartCommitPilot.blame.avatars` uses the editor’s account icon.

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
