# UIT Studio

Local web workspace for UIT Moodle courses, with optional Codex Agent mode.

Both npm and native installations run the same web application. Native
packages include Node.js and the pinned Chromium runtime used for UIT SSO.
The npm installation requires [Node.js 24.0+](https://nodejs.org/).

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

Or install the Linux native web release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --studio
```
</details>

<details>
<summary>Windows</summary>

Install the native web release in PowerShell:

```powershell
$installer = Join-Path $env:TEMP "uit-studio-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer -Studio
uit-studio
uit-studio --version
```

The npm alternative requires [Node.js 24.0+](https://nodejs.org/).

</details>

Agent mode additionally requires the [Codex CLI](https://developers.openai.com/codex/cli/):

```bash
npm install -g @openai/codex
codex --login
```
