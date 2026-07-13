# Change Log

All notable changes to the "smart-commit-pilot" extension will be documented in this file.

This project follows [Keep a Changelog](http://keepachangelog.com/) conventions.

## [Unreleased]

## [0.1.0] - 2026-07-13

### Added

- Added current-line Git blame hints with author, relative time, and commit summary in the editor.
- Added rich commit hovers with author avatars, exact commit time, commit message, and copyable commit hash.
- Added working-tree-aware blame so new and modified lines are shown as uncommitted while unchanged lines retain their commit history, including before the document is saved.
- Added `Smart Git Pilot: Toggle Current Line Blame` and the `smartCommitPilot.blame.enabled` setting.
- Added the `smartCommitPilot.blame.avatars` setting to disable remote Gravatar and generated cartoon avatars.

### Changed

- Renamed the user-facing extension brand from SmartCommitPilot to Smart Git Pilot to reflect its broader Git workflow capabilities. The extension ID, command IDs, and setting keys remain unchanged.

## [0.0.3]

### Changed

- Replaced the generic sparkle toolbar icon with a dedicated Smart Commit Pilot mark in the Source Control panel title bar, so it's no longer visually identical to other AI extensions (e.g. GitLens) using the same built-in icon.
- `Smart Commit Pilot: Setup Prompt` now opens the prompt in a dedicated multi-line text editor instead of the Settings UI.

### Fixed

- Fixed `Smart Commit Pilot: Setup Prompt` hanging Cursor — it no longer relies on `workbench.action.openSettings` with a search query, which is a known Cursor regression.
- Fixed commit-generation diagnostic logs going to the Extension Host developer console instead of the "Smart Commit Pilot" Output channel, where they were invisible to users checking the Output panel.

## [0.0.1]

### Added

- Generate a commit message from staged changes via the ✨ icon in the Source Control panel title bar, or the `Smart Commit Pilot: Generate Commit Message` command.
- Support for OpenAI and Anthropic as pluggable providers, configured via `Smart Commit Pilot: Setup Provider` (provider, base URL, and API key).
- API keys stored securely in VS Code's secret storage instead of `settings.json`.
- `Smart Commit Pilot: Select Model` command to fetch and choose from the live model list of the configured provider.
- `Smart Commit Pilot: Setup Prompt` command to customize the commit-message instructions via the `smartCommitPilot.prompt` setting.
- Built-in Conventional Commits prompt template, validated against `@commitlint/config-conventional` rules, used when no custom prompt is set.
