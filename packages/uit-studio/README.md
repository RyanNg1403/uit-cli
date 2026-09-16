# UIT Studio

Desktop workspace for UIT Moodle courses, with optional Codex Agent mode.

<details>
<summary>macOS</summary>

```bash
npm install -g uit-studio
uit-studio
uit-studio --version
```

</details>

<details>
<summary>Linux</summary>

```bash
npm install -g uit-studio
uit-studio
uit-studio --version
```

Or install the Linux AppImage release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --studio
```
</details>

<details>
<summary>Windows</summary>

Install [Node.js 20.19+](https://nodejs.org/), then run in PowerShell:

```powershell
npm install -g uit-studio
uit-studio
uit-studio --version
```

Release installers: [GitHub Releases](https://github.com/RyanNg1403/uit-cli/releases).
</details>

The browser launch is available as an experimental preview while the native
desktop path remains the default:

```bash
uit-studio --web
```

The preview uses the system browser for the Studio UI. UIT SSO login remains
on the native path until the bundled SSO browser adapter is added.

Agent mode additionally requires the [Codex CLI](https://developers.openai.com/codex/cli/):

```bash
npm install -g @openai/codex
codex --login
```
