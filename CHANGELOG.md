# Changelog

## [1.3.2] - 2026-09-12

- Added session file upload support and web HTML fallbacks for modern Moodle instances.
- Added multi-browser SSO login fallback across Google Chrome, Microsoft Edge, and Playwright Chromium.
- Prioritized official course announcement forums in `uit announcements`.
- Added automatic Course Module ID to assignment ID resolution and diagnostic hints for `uit status`.
- Replaced platform-specific subshells with cross-platform protocol and app launching in Studio.
- Increased Studio SSO session restore probe timeout to 30 seconds for higher network resilience.
- Added multi-platform Studio desktop builds for Linux and Windows alongside macOS.
- Hardened CI release unshallowing and standalone packaging checksum fallbacks.

## [1.3.0] - 2026-09-11

- Applied the Đậu Đậu mascot icon to shell-launched Studio windows and app identity on macOS, Linux, and Windows.

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
