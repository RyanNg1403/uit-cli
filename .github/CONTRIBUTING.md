# Contributing to uit-cli

Thanks for contributing to `uit-cli`! This guide explains our Git workflow, development setup, and pull request process.

---

## 1. Development Prerequisites

- **Node.js**: `>= 20.19.0`
- **npm**: `>= 10.0.0`
- **Supported Platforms**: macOS, Linux, Windows

### Quick Start

```bash
git clone https://github.com/RyanNg1403/uit-cli.git
cd uit-cli
npm install
npm test
```

---

## 2. Git Workflow

We follow a structured, release-branching Git workflow:

```text
main ───────────────────────────────────────────* (tagged release)
  │                                            ▲
  ├─► fix/<name>  ──┐                          │
  ├─► feat/<name> ──┼─► release/<version> ─────┘
                    │   (stabilization & release prep)
```

1. **Always branch from the latest `main`**:
   Before starting any fix or feature, ensure your local `main` is up-to-date and branch off it:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/<name> # or fix/<name>, chore/<name>, proj/<name>
   ```

2. **Branch Naming Conventions**:
   All branches pushed to remote must adhere to these prefixes (enforced by local hooks and CI):
   - `feat/**`: For new features and implementations.
   - `fix/**`: For hot fixes or bug fixing.
   - `chore/**`: For updating documentation, READMEs, bumping versions, and basic maintenance chores.
   - `proj/**`: For major implementation plans that incorporate multiple PRs before merging into a release.
   - `release/**`: Dedicated branch for release stabilization and publication prep.
   - `main`: Production-stable default branch.

3. **Commit Message Format**:
   Commit messages must match their branch prefix:
   ```text
   <feat|proj|fix|chore>: <description>
   ```
   *(e.g., branch `feat/sso-browser` requires commits like `feat: add edge fallback for sso`).*
   Violations are rejected by the repository's `commit-msg` hook. Note that there is no `release:` commit prefix; release preparation commits use `chore:` (e.g. `chore: prepare v1.3.2`), and merging a release branch into `main` produces a standard merge commit.

4. **Targeting a Release**:
   - For regular fixes and features, open a PR targeting `main` (or the active `release/<version>` branch if coordinating an imminent release).
   - When preparing a release, a dedicated `release/<version>` branch is created (e.g. `release/v1.3.2`).
   - Both `main` and `release/**` branches are strictly protected: direct pushes are prohibited without exception, requiring all changes to arrive via pull requests.
   - Feature and fix branches for that release cycle are merged into the release branch.

5. **Release Finalization & Deployment**:
   - Once all fixes are merged into `release/<version>`, versions are synchronized, changelogs updated, and full test pipelines (including Electron stability) pass.
   - The release branch is merged into `main`.
   - Creating a git tag (`v<version>`) on `main` triggers automated builds and deployments to GitHub Releases and npm.

---

## 3. Code Standards & Quality

- **Minimal & Concise**: Write the smallest, cleanest amount of code necessary. Avoid unnecessary dependencies or over-engineered abstractions.
- **Cross-Platform**: Never assume macOS-only tools (`open`, `pbcopy`, BSD flags). Code must run seamlessly across macOS, Linux, and Windows.
- **Full Verification**: Every change must be covered by tests and pass all linting and typecheck suites.

### Key Verification Commands

```bash
# Unit & integration tests
npm test

# TypeScript typechecking (CLI + Desktop + Preload)
npm run typecheck

# Code formatting & linting
npm run lint

# Package boundaries & standalone bundles
npm run package:check
npm run studio:check
npm run installer:check

# Electron desktop stability (run before submitting desktop PRs)
npm run test:electron
npm run test:desktop
```

---

## 4. Submitting a Pull Request

1. Ensure all verification checks pass locally (`npm test && npm run lint && npm run typecheck`).
2. Keep commits atomic with descriptive commit messages following our conventions (`feat: ...`, `fix: ...`, `chore: ...`, `proj: ...`, `release: ...`).
3. Open a PR using our Pull Request template, providing context on what was changed and how it was verified.
