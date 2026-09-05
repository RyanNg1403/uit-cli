# Desktop Browser Suite

Run `npx --no-install playwright test`. The suite uses the installed
`playwright/test`, Chromium, and a worker-scoped HTTP server that serves the
current `desktop/renderer` files without rewriting them. No build is required.

`desktop.ts` installs a fake `window.uit` before renderer startup. It records
bridge calls, supports deterministic held responses and failures, and emits
agent notifications without invoking Electron, Moodle, Codex, or a model.
Browser requests outside the fixture server fail the test.

The seed contains 19 courses, three known semesters plus an unknown semester,
duplicate course IDs across current and legacy portals, two connected accounts,
an additional disconnected account, three modules, eight file variants, seven
assignments, and six announcements. Session changes persist within each test's
browser context so reload tests preserve the simulated account identity.

Screenshots and failure traces are in `test-results/artifacts`. The HTML report
in `test-results/report` retains console and page-error attachments for each
test, including successful tests. View it with
`npx --no-install playwright show-report test-results/report`.

Suggested package scripts (not installed by this change):

```json
{
  "test:desktop": "playwright test",
  "test:desktop:repeat": "playwright test --repeat-each=2",
  "test:desktop:report": "playwright show-report test-results/report"
}
```

Browser coverage does not validate the real preload or IPC implementation.
Real Electron smoke must first have isolated `UIT_TEST_PROFILE` and
`UIT_DISABLE_CONFIG=1` support and compiled `dist` services. Never launch that
smoke against the developer's regular Electron profile or saved credentials.
