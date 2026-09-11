# Changelog

## [1.2.3] - 2026-09-11

- Removed the manual token argument from the public CLI login flows.
- Closed the temporary Studio SSO window after capturing the session without losing the authenticated transport.
- Added the Đậu Đậu motion and a centered all-course New Thread action to the empty Codex view.
- Added a clickable Codex SVG home icon that restores the empty agent view without deleting saved threads.

## [1.2.2] - 2026-09-11

- Restored self-service legacy login with `uit login --legacy`.
- Kept SSO as the default and retained the interactive legacy Moodle flow.
- Clarified login and installation documentation.

## [1.2.1] - 2026-09-10

- Added Node-free standalone CLI installers for macOS arm64 and Linux.
- Added the Playwright-free `uit-runtime` and npm-installable `uit-studio` packages.
- Added the CLI/Studio installation matrix and refreshed screenshots.

## [1.2.0] - 2026-09-10

- Added UIT Studio, current-site SSO, multi-account course workspaces, and the workspace-gated MCP server.
- Added authenticated previews, course discovery, Codex study threads, and mascot branding.

## [1.1.0] - 2026-06-27

- Added H5P activity downloads and dependency-free extraction.
- Improved wrong-ID errors and hardened archive path handling.

## [1.0.0] - 2026-05-17

- Initial TypeScript/npm release of the UIT CLI.
- Added interactive `uit init` login, Moodle API access, downloads, deadlines, grades, submissions, forums, and JSON output.
