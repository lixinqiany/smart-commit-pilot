# Change Log

All notable changes to the "smart-commit-pilot" extension will be documented in this file.

This project follows [Keep a Changelog](http://keepachangelog.com/) conventions.

## [Unreleased]

## [0.0.1]

### Added

- Generate a commit message from staged changes via the ✨ icon in the Source Control panel title bar, or the `Smart Commit Pilot: Generate Commit Message` command.
- Support for OpenAI and Anthropic as pluggable providers, configured via `Smart Commit Pilot: Setup Provider` (provider, base URL, and API key).
- API keys stored securely in VS Code's secret storage instead of `settings.json`.
- `Smart Commit Pilot: Select Model` command to fetch and choose from the live model list of the configured provider.
- `Smart Commit Pilot: Setup Prompt` command to customize the commit-message instructions via the `smartCommitPilot.prompt` setting.
- Built-in Conventional Commits prompt template, validated against `@commitlint/config-conventional` rules, used when no custom prompt is set.
