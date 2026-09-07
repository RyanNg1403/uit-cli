<p align="center">
  <img src="assets/logo.svg" alt="UIT Studio" width="480">
</p>

<p align="center">
  <strong>The modern, AI-powered desktop workspace for UIT Moodle LMS.</strong><br>
  Browse courses, inspect lecture slides, track grades, connect with lecturers, and study with an intelligent AI copilot.
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> &bull;
  <a href="#features"><strong>Features</strong></a> &bull;
  <a href="#shortcuts--controls"><strong>Shortcuts & Appearance</strong></a> &bull;
  <a href="#security--privacy"><strong>Security & Privacy</strong></a>
</p>

<p align="center">
  <img src="assets/studio-chat.png" alt="UIT Studio - Codex AI Workspace" width="860" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.25);">
</p>

---

## Quick Start

Run UIT Studio on macOS, Windows, or Linux (Node.js 20+ required):

```bash
git clone https://github.com/RyanNg1403/uit-cli.git && cd uit-cli
npm install
npm run desktop
```

Log in directly using your **UIT SSO** credentials or **Legacy Moodle** student account. Your session token is stored locally on your machine.

---

## Features

### 1. Codex AI Assistant & Study Partner
Study with an AI tutor that knows your courses. Codex inspects lecture slides, syllabus files, and assignments on demand to answer questions with real-time academic context.

* **Smart Course Grounding**: Ask about specific assignments, lecture concepts, or exam prep.
* **Distraction-Free Workspace**: Fast thread switching, double-click title renaming, and thread branching to explore alternative study tracks.
* **Model Selection**: Switch between AI reasoning models directly in the composer.

---

### 2. Dedicated Course Hub
Every course features three focused, student-centered tabs:

| Materials & Previews | Class Members & Lecturers | Grades & Feedback |
| :---: | :---: | :---: |
| <img src="assets/course-materials.png" width="270" alt="Materials Tab" style="border-radius: 6px;"> | <img src="assets/course-members.png" width="270" alt="Members Tab" style="border-radius: 6px;"> | <img src="assets/course-grades.png" width="270" alt="Grades Tab" style="border-radius: 6px;"> |
| Continuous multi-page PDF viewer, Word (`.docx`) previews, and lecture files. | Class roster with lecturers pinned on top, teacher badges, and instant search. | Course Total summary card, component score breakdown, and teacher feedback. |

* **Built-in Document Previews**: Read PDFs, images, code files, and Word documents directly inside the app without external software.
* **Native Multi-Page PDF Viewer**: Canvas rendering with page jumping, zoom controls, and automatic dark mode adaptation.

---

### 3. Dual Portals & Academic Year Dashboard
Connect both **courses.uit.edu.vn** (SSO) and **coursesold.uit.edu.vn** (Legacy) into a single, unified view.

<p align="center">
  <img src="assets/studio-courses.png" alt="UIT Studio Courses Dashboard" width="860" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.25);">
</p>

* **Calendar Year Grouping**: Courses are grouped into clean academic year cards (`2026`, `2025`).
* **Instant Filter**: Search across all terms, course codes, and titles in real time.

---

## Shortcuts & Controls

| Shortcut / Action | Action Description |
| :--- | :--- |
| <kbd>Cmd</kbd>+<kbd>B</kbd> / <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle the left navigation sidebar |
| **Drag sidebar edge** | Resize navigation rail to your preferred width |
| **Double-click thread title** | Quick rename chat conversation |
| **Appearance Switcher** | Toggle between **System**, **Light**, and **Dark** at the bottom of the sidebar |

---

## Testing

UIT Studio includes an automated test suite:

```bash
npm run test:desktop    # 112 Playwright UI, PDF viewer, and layout tests
npm run test:electron   # 60-second Electron stability and memory soak test
npm test                # unit and integration test suite
```

---

## Security & Privacy

* **Direct Moodle Connection**: UIT Studio communicates directly from your device to the UIT Moodle servers using official Web Service APIs.
* **Local Storage Only**: Passwords and session tokens never touch external servers or third-party backends.
* **Non-Escalating**: The app only accesses courses and data your account has official permission to view.

---

> Looking for the terminal CLI? See the [CLI Reference](docs/CLI_REFERENCE.md).

## License

MIT
