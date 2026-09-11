<p align="center">
  <img src="assets/logo.svg" alt="UIT CLI & UIT Studio" width="460">
</p>

<p align="center">
  <strong>The modern command-line tool and AI desktop workspace for UIT Moodle LMS.</strong>
</p>

---

## 1. UIT CLI

Fast, scriptable terminal client for browsing courses, checking assignments, downloading materials, and tracking grades.

### Installation

On Apple Silicon macOS or Linux, install the standalone CLI and MCP server without Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh
```

Alternatively, install from npm:

```bash
npm install -g uit-cli
```

The CLI package does not install the desktop app or a bundled Chromium browser. SSO opens an installed Google Chrome window; the CLI captures the session in its own controlled browser context. If you also want UIT Studio, install its separate npm package:

```bash
npm install -g uit-studio
uit-studio
```

The standalone curl installer supports Apple Silicon macOS and Linux x64/arm64 without a preinstalled Node.js runtime. UIT CLI supports Node.js 20.19 or later when installed from npm (or on other Unix-like systems where the installer falls back to npm).

To work from source instead:

```bash
git clone https://github.com/RyanNg1403/uit-cli.git
cd uit-cli
npm ci
npm link
```

### Login

`uit login` supports both **UIT SSO** and **Moodle API tokens**:

```bash
# Recommended: Sign in via UIT SSO in browser (default)
uit login

# Or sign in via Moodle API token
uit login --token <your_token>
```

*Tip: If you already signed in via **UIT Studio**, your SSO session is automatically shared with the CLI.*

### Basic Usage

| Command | Description |
| :--- | :--- |
| `uit courses` | List enrolled courses with course IDs |
| `uit contents <course_id>` | Browse sections, lecture slides, and files |
| `uit deadlines` | View assignment deadlines and submission status |
| `uit grades <course_id>` | Check grades, weights, and teacher feedback |
| `uit download <course_id>` | Download course materials and lecture slides |

<p align="center">
  <img src="assets/demo.gif" alt="UIT CLI Demo" width="860">
</p>

---

## 2. UIT Studio

The native desktop workspace combining Moodle course management with an intelligent Codex AI study copilot.

### Installation & Launch

UIT Studio is currently distributed for Apple Silicon Macs (arm64) only. The downloadable builds are unsigned to keep distribution free, so macOS may block the first launch. If it does, open **System Settings → Privacy & Security** and choose **Open Anyway** for UIT Studio.

Install UIT Studio into `~/Applications` from the macOS release:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --studio
```

Install both UIT CLI and UIT Studio:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --all
```

The installer detects the Mac architecture and verifies the release archive's SHA-256 checksum. You can also download the unsigned DMG directly from the [latest GitHub release](https://github.com/RyanNg1403/uit-cli/releases/latest).

For an npm-managed installation, use the dedicated Studio package instead:

```bash
npm install -g uit-studio
uit-studio
```

To launch from source instead, install Node.js 20.19 or later and run:

```bash
git clone https://github.com/RyanNg1403/uit-cli.git
cd uit-cli
npm ci
npm run desktop
```

### Login

Sign in directly using **UIT SSO** (single sign-on) or your **Legacy Moodle** student account. Sessions are stored securely on your local device.

### What UIT Studio includes

- A unified dashboard for current and legacy UIT Moodle portals.
- Course materials with PDF, Word, image, text, and code previews.
- Class members, lecturers, grades, feedback, and deadlines.
- Codex study threads grounded in selected courses and resources.

<p align="center">
  <img src="assets/studio-courses.png" alt="UIT Studio courses dashboard" width="860">
</p>

Chat with Codex using direct context from your courses, lecture slides, and assignments, then continue the same thread in Codex CLI or the ChatGPT desktop app.

<p align="center">
  <img src="assets/studio-chat.png" alt="Codex AI Workspace" width="860" style="border-radius: 8px;">
</p>

---

## License

MIT
