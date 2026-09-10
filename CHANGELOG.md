# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning. For new releases, update the version with `npm version patch`, `npm version minor`, or `npm version major`, then push the generated tag.

## [1.2.0] - 2026-09-09

### Added

- Added UIT Studio, including course resources, members, grades, authenticated previews, multi-account support, and Codex-powered course workspaces.
- Added UIT SSO login alongside legacy Moodle token authentication.
- Added the workspace-gated UIT MCP server and Codex CLI/App integration.
- Added linting, desktop UI coverage, Electron stability coverage, and npm package verification to CI.
- Added free unsigned macOS packaging for Apple Silicon and Intel, with GitHub Release artifacts and SHA-256 checksums.
- Added a repository-hosted installer for the CLI, UIT Studio, or both.
- Added Đậu Đậu, the UIT panda mascot, to Studio's account onboarding state.

### Changed

- Parallelized independent SSO course discovery requests.
- Avoid repeated Codex rollout directory scans and unchanged history-file reads.
- Unified active-session resolution across the CLI and MCP server.
- Replaced legacy `.env` credential storage with `~/.uit/sessions.json`; users upgrading from 1.1 or earlier must sign in again.

### Fixed

- Prevented direct MCP tool calls from bypassing workspace gating.
- Prevented Moodle file metadata from escaping the selected download directory.
- Made credential-file updates atomic and private.
- Made packaged UIT Studio register a runnable embedded MCP command instead of a Node path trapped inside its application archive.
- Made npm installations provision the Chromium runtime required by CLI SSO login.
- Made an explicit token login remain active when an SSO session also exists.
- Made CLI SSO course discovery report authentication, permission, and network failures instead of returning an empty list.

## [1.1.0] - 2026-06-27

### Added

- `uit download` now retrieves H5P activities (`h5pactivity` modules): their `.h5p` package is downloaded alongside regular course files. Previously these activities were silent — `core_course_get_contents` exposes no files for them ([#3](https://github.com/RyanNg1403/uit-cli/issues/3)).
- Added `uit download --extract` to unpack a downloaded `.h5p` package's media (slides, images, video) into a folder beside it, using a dependency-free ZIP reader. Works on already-downloaded packages without `--force`.
- `uit view` on an `h5pactivity` module now lists its package file and prints a download tip, matching how resources are shown.

### Changed

- `uit download` rejects a module ID passed where a course ID is expected, with a hint to use `--module`, instead of surfacing Moodle's raw "course not found" error.
- Course-scoped commands (`contents`, `announcements`, `grades`, `download`) now detect a wrong or inaccessible course ID by Moodle error code and show a consistent "check the ID" hint, regardless of the server's language.
- `uit download` surfaces a warning when a course's H5P packages cannot be loaded, instead of silently skipping them.

### Fixed

- Hardened the `.h5p` extractor against archive entries that try to escape the output directory (path traversal), including backslash separators on Windows.

### Verified

- Tested H5P package download, `--extract` (including re-extracting existing packages), the wrong-ID hint, and `uit view` on an H5P module against the live UIT Moodle service.
- Confirmed regular file download and skip-existing behavior are unchanged.

## [1.0.0] - 2026-05-17

### Added

- Published `uit-cli` to npm with the `uit` binary.
- Added TypeScript implementation of the full CLI command set.
- Added interactive `uit init` login flow that requests a Moodle Mobile token and stores credentials locally in `~/.uit/.env`.
- Added `uit init --token <token>` for users who prefer manual token setup.
- Added GitHub Actions workflows for CI and tag-based npm releases.
- Added regression tests for command behavior, output helpers, config parsing, token requests, and mocked Moodle API flows.

### Changed

- Ported the project from Python packaging to a standard TypeScript/npm package structure.
- Updated README and CLI reference for npm installation, source builds, local-only credential storage, and release workflow.

### Verified

- Tested read-only Moodle commands against the live UIT Moodle service.
- Tested targeted file download.
- Tested assignment submission on the throwaway assignment `50664`.
