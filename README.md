# Smart Git Pilot

Manage Git branches, inspect current-line history, and generate AI-powered commit messages in VS Code.

The interface follows the VS Code display language. Simplified and Traditional Chinese are supported, with English for other languages. Your prompt controls the language of generated commit messages.

## Features

- **One-click generation** — click the Smart Git Pilot icon in the Source Control panel's title bar and it writes a commit message straight into the commit input box.
- **Bring your own provider** — works with either OpenAI or Anthropic. You supply the API key and base URL, so it also works with OpenAI/Anthropic-compatible proxies and self-hosted gateways.
- **Conventional Commits by default** — the built-in prompt asks the model for a `type(scope): subject` header plus body/footer, validated against `@commitlint/config-conventional` rules (lowercase type, 100-char line wraps, `BREAKING CHANGE:` footer handling, etc.).
- **Customizable prompt** — override the default instructions with your own house style via a single setting.
- **Secure credentials** — your API key is stored in VS Code's encrypted secret storage, never written to `settings.json`.
- **Model picker** — fetches the live list of models available to your account/provider and lets you pick one, instead of hardcoding a model name.
- **Current line blame** — shows the author, relative time, and commit summary for the active line, with full details and a copyable hash on hover. Local edits are marked as uncommitted without losing history for unchanged lines.

## Branches

Open **Source Control → Smart Git Pilot**. Use the title icons to select local branches, remotes, tags, or contributors. The refresh arrow reloads the selected view. The active icon has an underline. Each workspace remembers the last view and the local branch layout.

- **Branches (N)** shows a flat list of full local branch names by default. Hover or focus the count row and select **View as Tree** to group other branches by slash-separated prefixes. A shared path such as `feature/mobile` appears as one folder. Select **View as List** to return to the flat list. The count row also offers switch, create (**+**), and refresh actions. The checked-out branch stays first and uses a branch icon with solid nodes and a **Current** label, even when another row is hovered.
- **Tags (N)** lists local tags by their full names, newest first. Expand a tag to browse its history, or hover to read its message.
- **Contributors (N)** shows commit authors on the current branch by non-merge commit count, with their latest contribution time. Expand an author to see their commits. The count row switches between the current branch and all local and remote branches.
- **Remotes (N)** is a fixed heading. Each remote, such as `origin`, starts collapsed. Expand it to see fetched branches by their full name within that remote, such as `feature/login`. Empty remotes appear as plain rows. The heading’s **+** adds a remote by name and URL. Use **Git: Fetch** to retrieve remote refs.
- Right-click a local branch and select **Delete Local Branch…**. Choose local deletion or the row naming the remote branch to delete as well. The picker shows the configured upstream, or fetched same-name branches when there is no upstream. Toggle **Force deletion** before choosing a scope to allow unmerged commits.
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

You can re-run **Setup Provider** or **Select Commit Message Model** any time to switch providers or models.

## Extension Settings

| Setting | Description |
|---|---|
| `smartCommitPilot.provider` | Selected LLM vendor: `OpenAI` or `Anthropic`. |
| `smartCommitPilot.baseUrl` | Base URL used to reach the selected provider (supports compatible proxies/gateways). |
| `smartCommitPilot.model` | Model used to generate commit messages, chosen via **Select Commit Message Model**. |
| `smartCommitPilot.composer.model` | Model used for splitting commits and refining drafts, chosen in **Draft settings**. |
| `smartCommitPilot.prompt` | Custom instructions appended to the commit-message prompt. Leave empty to use the built-in Conventional Commits template. |
| `smartCommitPilot.blame.enabled` | Shows commit information for the current editor line. Enabled by default. |
| `smartCommitPilot.blame.avatars` | Shows author avatars in branch history and blame hovers. Enabled by default. |

Your API key is **not** stored in this list — it lives in VS Code's secret storage and is set via **Setup Provider**.

With avatars enabled, VS Code can request an image from GitHub for a GitHub noreply identity or from Gravatar using a hash of the author’s email. Gravatar supplies a RoboHash robot when the author has no profile image. Turning off `smartCommitPilot.blame.avatars` uses the editor’s account icon.

## Commands

| Command | What it does |
|---|---|
| `Smart Git Pilot: Setup Provider` | Configure provider, base URL, and API key; then prompts you to select a model. |
| `Smart Git Pilot: Select Commit Message Model` | Choose the model used by **Generate Commit Message**. |
| `Smart Git Pilot: Setup Prompt` | Opens the `smartCommitPilot.prompt` instructions in a multi-line editor; save (Cmd/Ctrl+S) to apply. |
| `Smart Git Pilot: Generate Commit Message` | Generates a commit message from staged changes (also available as the icon in the Source Control title bar). |
| `Smart Git Pilot: Split Changes into Commits…` | Review AI-grouped changes and edit each message before creating the commits. Available beside Generate Commit Message in Source Control, or with Ctrl+K Ctrl+Shift+G (Cmd+K Cmd+Shift+G on macOS). |
| `Smart Git Pilot: Toggle Current Line Blame` | Enables or disables the current-line commit hint for the workspace. |

## Splitting changes into commits

1. Choose **Staged changes** for changes selected with **+** or `git add`. **All saved changes** includes saved edits, deletions and new files that Git tracks or would add. If you edit a file after staging it, this option uses the last saved version. The file list shows the paths and Git status for the selected scope.
2. Enter optional grouping instructions and select **Generate drafts with AI**. Automatic mode groups small edits in one request. For larger or interdependent edits, it analyzes their purposes and dependencies, groups the edits, then orders the commits. The first AI split asks you to choose a split model using your configured provider. Change it later in **Draft settings**, where you can also choose **Quick** or **Deep**. For example, ask for separate commits for the retry fix, branch panel and keyboard shortcut. **Group manually** starts with one local draft containing the selected changes.
3. Select a draft to review its diff and edit its message. Drag drafts to reorder them. Check a file to select all its changes. To split a single file, expand it and choose **Select part of this file**. Check a change block or individual edits inside it, then choose **Move selected changes…** and an existing or new draft. A replacement moves its old and new lines together. You can also drag a file onto a draft. Moving the last change out removes the empty draft. Reordering and moving files run locally.
4. Use **Draft actions** to split the selected draft further, regenerate its message or move it up or down. **Lock draft** keeps its exact diff and message. Select **Refine with AI…**, describe the change and choose **Update drafts**. **Back to review** closes the instructions and keeps your drafts. AI uses the same snapshot and can regroup the unlocked drafts on either side of a lock. Unlock the draft to move changes across it.
5. Before preview, the extension builds each successive Git tree. It checks package and Composer JSON manifests and runs the editor’s TypeScript compiler for projects with a tsconfig.json, using installed dependencies. Each draft lists the checks that ran, new diagnostics, and the count of pre-existing diagnostics. Other projects receive Git tree verification. Clear dependency-order fixes are rechecked locally.
6. Choose **Create commits…** and confirm the ordered list. Git runs hooks and signing in a temporary worktree before applying the reviewed commits to your branch.

Multi-round planning puts the numbered diff in a stable prompt prefix. On supported providers the extension marks this prefix for reuse across analysis, grouping, ordering and follow-up edits. Quick planning and one-off commit messages request no cache writes where supported. Actual reads and writes appear in the extension output when the provider reports them.

## Known Issues

- Generate Commit Message requires at least one staged change — Smart Git Pilot won't generate a message from unstaged or working-tree changes.
- Very large diffs may be truncated or produce lower-quality messages depending on the selected model's context window.
- Current line blame requires the Git executable configured for VS Code, or `git` available on your PATH.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

**Enjoy!**
