/**
 * Screenshot Capture Suite for UIT Studio UI Review
 *
 * Captures comprehensive screenshots of every major view and state
 * for the purpose of UI improvement analysis.
 *
 * Run with:
 *   npx playwright test screenshots --config=playwright.config.ts
 */
import { test, expect, courses, fileTypes, openCourse, emit } from "./fixtures/desktop";
import type { Page } from "playwright/test";

const SCREENSHOT_DIR = "test-results/screenshots";

/* ─── Helper ──────────────────────────────────────── */
function out(name: string) {
  return { path: `${SCREENSHOT_DIR}/${name}.png` };
}

/* ─────────────────────────────────────────────────── *
 *  1.  COURSES VIEW                                   *
 * ─────────────────────────────────────────────────── */

test("01 — Courses list (light mode, all semesters)", async ({ page, boot }) => {
  await boot();
  await page.screenshot({ ...out("01-courses-light"), fullPage: true });
});

test("02 — Courses list (dark mode)", async ({ page, boot }) => {
  await boot();
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.waitForTimeout(200);
  await page.screenshot({ ...out("02-courses-dark"), fullPage: true });
});

test("03 — Courses search active", async ({ page, boot }) => {
  await boot();
  await page.getByRole("searchbox").fill("Computer science 5");
  await page.waitForTimeout(200);
  await page.screenshot({ ...out("03-courses-search") });
});

test("04 — Courses filtered by semester", async ({ page, boot }) => {
  await boot();
  await page.getByLabel("Semester", { exact: true }).selectOption("2026-1");
  await page.waitForTimeout(200);
  await page.screenshot({ ...out("04-courses-semester-filter") });
});

/* ─────────────────────────────────────────────────── *
 *  2.  COURSE DETAIL VIEW                             *
 * ─────────────────────────────────────────────────── */

test("05 — Course detail — Contents tab", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.screenshot({ ...out("05-course-contents"), fullPage: true });
});

test("06 — Course detail — Members tab", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("tab", { name: "Members" }).or(page.locator('[data-tab="members"]')).click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("06-course-members") });
});

test("07 — Course detail — Grades tab", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("tab", { name: "Grades" }).or(page.locator('[data-tab="grades"]')).click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("07-course-grades") });
});

test("08 — Course detail — Assignment sections (inside materials)", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  // Assignments are rendered as sections within the materials tab — scroll down to show them
  const assignmentSection = page.locator("#assignment-list").or(page.locator("text=Assignment 1"));
  if (await assignmentSection.count()) {
    await assignmentSection.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ ...out("08-course-assignments-section"), fullPage: true });
});

test("10 — Course detail (dark mode)", async ({ page, boot }) => {
  await boot();
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await openCourse(page);
  await page.screenshot({ ...out("10-course-contents-dark"), fullPage: true });
});

/* ─────────────────────────────────────────────────── *
 *  3.  CODEX AI VIEW                                  *
 * ─────────────────────────────────────────────────── */

test("11 — Codex empty state (no project selected)", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("11-codex-empty") });
});

test("12 — Codex with project selected (blank thread)", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("12-codex-blank-thread") });
});

test("13 — Codex with chat messages", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();

  // Send a message and simulate a response
  await page.getByLabel("Message Codex").fill("Explain the key concepts of this course");
  await page.locator("#send-agent").click();
  await page.locator("#stop-agent").click();
  await expect(page.locator("#agent-status")).toHaveText("Ready");

  // Simulate a response message by emitting turn events
  const threadId = await page.evaluate(() => {
    const link = document.querySelector(".thread-link");
    return link?.getAttribute("data-thread") || "thread-1";
  });

  await page.waitForTimeout(300);
  await page.screenshot({ ...out("13-codex-with-messages") });
});

test("14 — Codex (dark mode)", async ({ page, boot }) => {
  await boot();
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("14-codex-dark") });
});

/* ─────────────────────────────────────────────────── *
 *  4.  LOGIN MODAL                                    *
 * ─────────────────────────────────────────────────── */

test("15 — Login modal (connected state)", async ({ page, boot }) => {
  await boot();
  await page.locator("#account-button").click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("15-login-modal-connected") });
});

test("16 — Login modal (disconnected state)", async ({ page, boot }) => {
  await boot({ authenticated: false });
  await page.locator("#account-button").click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("16-login-modal-disconnected") });
});

test("17 — Login modal (dark mode)", async ({ page, boot }) => {
  await boot();
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.locator("#account-button").click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("17-login-modal-dark") });
});

/* ─────────────────────────────────────────────────── *
 *  5.  FILE / RESOURCE PREVIEW                        *
 * ─────────────────────────────────────────────────── */

test("18 — Resource reader — Text file preview", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  // Click the first file resource to open the reader
  const firstFile = page.locator('[data-resource-kind="file"]').first();
  await firstFile.click();
  await page.waitForTimeout(500);
  await page.screenshot({ ...out("18-resource-reader-text") });
});

test("19 — Resource reader — PDF preview", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  // Click the PDF resource
  const pdfFile = page.locator('[data-resource-kind="file"]').filter({ hasText: "slide.pdf" });
  if (await pdfFile.count()) {
    await pdfFile.click();
  } else {
    // Try clicking any .pdf named resource
    await page.locator('[data-resource-kind="file"]').nth(5).click();
  }
  await page.waitForTimeout(800);
  await page.screenshot({ ...out("19-resource-reader-pdf") });
});

/* ─────────────────────────────────────────────────── *
 *  6.  PROJECT PICKER DIALOG                          *
 * ─────────────────────────────────────────────────── */

test("20 — Project picker dialog", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("20-project-picker") });
});

test("21 — Project picker — Search filtered", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator("#project-search").fill("Legacy");
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("21-project-picker-search") });
});

test("22 — Project picker — Year filtered", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.getByLabel("Academic year", { exact: true }).selectOption("2025");
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("22-project-picker-year") });
});

/* ─────────────────────────────────────────────────── *
 *  7.  SIDEBAR STATES                                 *
 * ─────────────────────────────────────────────────── */

test("23 — Sidebar with courses nav", async ({ page, boot }) => {
  await boot();
  // Ensure sidebar is visible
  await page.screenshot({ ...out("23-sidebar-courses") });
});

test("24 — Sidebar with Codex threads", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();

  // Create a thread with a message
  await page.getByLabel("Message Codex").fill("Hello");
  await page.locator("#send-agent").click();
  await page.locator("#stop-agent").click();
  await expect(page.locator("#agent-status")).toHaveText("Ready");

  await page.waitForTimeout(300);
  await page.screenshot({ ...out("24-sidebar-codex-threads") });
});

/* ─────────────────────────────────────────────────── *
 *  8.  UNAUTHENTICATED / EMPTY STATES                 *
 * ─────────────────────────────────────────────────── */

test("25 — Unauthenticated state (no accounts)", async ({ page, boot }) => {
  await boot({ authenticated: false });
  await page.screenshot({ ...out("25-unauthenticated") });
});

test("26 — Unauthenticated state (dark mode)", async ({ page, boot }) => {
  await boot({ authenticated: false });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.waitForTimeout(200);
  await page.screenshot({ ...out("26-unauthenticated-dark") });
});

/* ─────────────────────────────────────────────────── *
 *  9.  MOBILE / NARROW VIEWPORT                       *
 * ─────────────────────────────────────────────────── */

test("27 — Courses on narrow viewport (mobile)", async ({ page, boot }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot();
  await page.screenshot({ ...out("27-courses-mobile"), fullPage: true });
});

test("28 — Course detail on narrow viewport (mobile)", async ({ page, boot }) => {
  // Boot at full width first so openCourse works, then resize
  await boot();
  await openCourse(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("28-course-detail-mobile"), fullPage: true });
});

test("29 — Codex on narrow viewport (mobile)", async ({ page, boot }) => {
  await boot();
  // Navigate to Codex at full width first
  await page.locator('[data-view="agent"]').click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("29-codex-mobile") });
});

test("30 — Sidebar open on mobile", async ({ page, boot }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot();
  // Toggle sidebar open on mobile
  await page.locator("#menu-toggle").click();
  await page.waitForTimeout(300);
  await page.screenshot({ ...out("30-sidebar-mobile") });
});
