<p align="center">
  <img src="assets/logo.svg" alt="UIT STUDIO" width="460">
</p>

<h1 align="center">UIT STUDIO</h1>

<p align="center">
  <strong>One workspace. Every course.</strong>
</p>

<p align="center">
  <a href="https://ryanng1403.github.io/uit-cli/">Open the UIT Studio landing page ↗</a>
</p>

---

## UIT Studio

Your course space. Built to focus.

Both installation methods launch the same local web Studio with `uit-studio`.
The npm installation requires [Node.js 24.0+](https://nodejs.org/); native
release packages include Node.js and the SSO Chromium runtime.

Open **Calendar** in Studio to browse Moodle events and assignment deadlines by month. Filter by account, course, or deadlines; select a day or expand an event to see its details and open it in Moodle. Calendar combines connected SSO and legacy accounts. Assignments with an explicit opening date and deadline appear as submission windows, continuing across weeks and months with a marked deadline. Crowded days show **+N more**. Select a bar for its dates and details. Missing opening dates remain single deadline markers; Studio does not infer dates or edit course events.

**Course announcements** below the calendar lists announcement posts across all dates, newest updated first. Choose **Date posted** to sort by the original posting date. Both timestamps are shown separately; unavailable dates remain labelled and sort last. Account, course and search filters apply; month/day and deadline filters do not restrict this list. Announcements load independently from the calendar, reuse a five-minute cache, and have a separate **Refresh announcements** action. Expand a post to read it or open it in Moodle. A partial failure preserves previously loaded posts and displays a warning.

Use **Refresh calendar** after a teacher changes a deadline. The visible calendar refreshes automatically every five minutes. Under **Deadline reminders**, enable reminders within 24 hours and 1 hour of deadlines Moodle marks as needing action. Studio must remain running; reminders appear in the app and, when supported and allowed by the OS, as desktop notifications. Reminder preferences and delivery history are saved locally, and changed deadlines are scheduled again. Times are displayed in your computer's time zone.

<details>
<summary>macOS</summary>

```bash
npm install -g uit-studio
uit-studio
```

Or install the Apple Silicon native web release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --studio
```
</details>

<details>
<summary>Linux</summary>

```bash
npm install -g uit-studio
uit-studio
```

Or install the Linux native web release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --studio
```
</details>

<details>
<summary>Windows</summary>

Install the native web release from PowerShell:

```powershell
$installer = Join-Path $env:TEMP "uit-studio-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer -Studio
uit-studio
uit-studio --version
```

The npm alternative requires [Node.js 24.0+](https://nodejs.org/):

```powershell
npm install -g uit-studio
uit-studio
```

</details>

### Agent mode requirement

Course features work without Codex. Agent mode requires the **Codex CLI**:

```bash
npm install -g @openai/codex
codex --login
```

The ChatGPT desktop app alone is not sufficient. Sign in to UIT Studio with UIT SSO or a legacy Moodle account.

<p align="center">
  <img src="docs/assets/studio-courses.png" alt="UIT Studio courses workspace" width="860">
</p>

Chat with Codex using course context, then continue the same thread in Codex CLI or the ChatGPT desktop app.

<p align="center">
  <img src="docs/assets/studio-chat.png" alt="UIT Studio agent workspace" width="860" style="border-radius: 8px;">
</p>

---

## UIT CLI

Your Moodle, at terminal speed.

The npm installation requires [Node.js 24.0+](https://nodejs.org/). Native
release packages include their own runtime.

<details>
<summary>macOS</summary>

```bash
npm install -g uit-cli
uit --version
```

Or install the signed-checksum standalone release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh
```
</details>

<details>
<summary>Linux</summary>

```bash
npm install -g uit-cli
uit --version
```

Or use the standalone release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh
```
</details>

<details>
<summary>Windows</summary>

Install [Node.js 24.0+](https://nodejs.org/), then run in PowerShell:

```powershell
npm install -g uit-cli
uit --version
```
</details>

Sign in with UIT SSO:

```bash
uit login
```

Use `uit login --legacy` for the legacy Moodle portal. An SSO session from UIT Studio is shared with the CLI.

<p align="center">
  <img src="assets/demo.gif" alt="UIT CLI Demo" width="860">
</p>

---

## Contributing

Contributions are welcome! Please check out our [Contributing Guidelines](.github/CONTRIBUTING.md) for details on our workflow, git conventions, and setup:

- **Git Workflow**: Always branch from the latest `main` and consolidate into `release/<version>` branches.
- **Branch Naming**: Branches must use `feat/**`, `fix/**`, `chore/**`, `proj/**`, or `release/**`.
- **Commit Conventions**: Commit messages must use a supported prefix (`feat:`, `fix:`, `chore:`, or `proj:`), enforced via local hooks and CI; the prefix does not need to match the branch name.
- **Issue & PR Templates**: Please follow our [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md) and [Issue Template](.github/ISSUE_TEMPLATE.md).

## License

MIT
