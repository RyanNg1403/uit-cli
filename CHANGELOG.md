# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning. For new releases, update the version with `npm version patch`, `npm version minor`, or `npm version major`, then push the generated tag.

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
