import { test, expect, courses, semesters, fileTypes, CURRENT, LEGACY, STORE, key, calls, control, emit, openCourse } from "./fixtures/desktop";
import type { Page } from "playwright/test";

async function sendAndStop(page: Page, message: string) {
  await page.getByLabel("Message Codex").fill(message);
  await page.locator("#send-agent").click();
  await page.locator("#stop-agent").click();
  await expect(page.locator("#agent-status")).toHaveText("Ready");
}
async function createThread(page: Page, index = 0) {
  await page.locator('[data-view="agent"]').click();
  const add = page.getByRole("button", { name: `New thread in ${courses[index].shortname}`, exact: true });
  if (await add.count()) await add.click();
  else {
    await page.locator("#new-project").click();
    await page.locator(".project-option").filter({ has: page.getByText(courses[index].fullname, { exact: true }) }).click();
  }
}
async function branchThread(page: Page) {
  await page.locator(".thread-row .thread-menu-btn").first().click();
  await page.getByRole("menuitem", { name: "Branch", exact: true }).click();
}

test("Codex has one creation entry per action and no scattered guidance", async ({ page, boot }, info) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await expect(page.locator("#agent-messages").getByRole("button", { name: "New Thread", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New project", exact: true })).toHaveCount(1);
  await expect(page.locator("#view-agent button:visible")).toHaveCount(1);
  await expect(page.locator("#view-agent select")).toHaveCount(0);
  await expect(page.locator(".composer")).toBeHidden();
  await expect(page.locator(".topbar-note, .keyboard-hint, #course-lock-note")).toHaveCount(0);
  await expect(page.locator("#agent-messages .agent-empty-mascot")).toHaveCount(1);
  await expect(page.locator("#agent-messages")).not.toContainText("No thread selected");
  await expect(page.locator(".thread-header")).toBeHidden();
  await expect(page.locator("#agent-task-title")).toHaveText("");
  await page.screenshot({ path: info.outputPath("codex-empty-clean.png") });
  await page.locator("#new-project").click();
  await page.locator(".project-option").filter({ has: page.getByText(courses[0].fullname, { exact: true }) }).click();
  await expect(page.locator("#agent-course")).toHaveCount(0);
  await expect(page.locator("#course-nav .project")).toContainText("CS01");
  await expect(page.locator(".project-new-thread")).toHaveCount(1);
  await expect(page.locator("#agent-messages")).toBeEmpty();
  await expect(page.locator("#page-title")).toHaveAttribute("aria-label", "Codex home");
  await expect(page.locator("#page-title .codex-page-icon")).toHaveCount(1);
  await expect(page.locator(".nav-item[data-view=agent] .nav-logo img")).toHaveAttribute("src", /uit-dau-dau\.svg/);
  await expect(page.locator(".thread-agent-identity")).toHaveCount(0);
  await expect(page.locator(".composer")).toBeVisible();
  await page.screenshot({ path: info.outputPath("codex-thread-clean.png") });
});

test("empty Codex state centers the mascot and offers every connected course", async ({ page, boot }) => {
  await boot({
    storage: JSON.stringify({ version: 1, activeId: null, projects: [courses[0]], threads: [] })
  });
  await page.locator('[data-view="agent"]').click();

  const messages = page.locator("#agent-messages");
  const empty = messages.locator(".thread-empty");
  const mascot = empty.locator(".agent-empty-mascot");
  await expect(mascot).toBeVisible();
  await expect(empty.getByRole("button", { name: "New Thread", exact: true })).toBeVisible();
  const [messagesBox, mascotBox] = await Promise.all([messages.boundingBox(), mascot.boundingBox()]);
  expect(messagesBox).not.toBeNull();
  expect(mascotBox).not.toBeNull();
  expect(Math.abs((mascotBox!.x + mascotBox!.width / 2) - (messagesBox!.x + messagesBox!.width / 2))).toBeLessThan(1);

  await empty.getByRole("button", { name: "New Thread", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Choose a project", exact: true })).toBeVisible();
  await expect(page.locator(".project-option")).toHaveCount(19);
  await page.locator(".project-option").filter({ hasText: courses[18].fullname }).click();
  await expect(page.locator("#project-picker")).toBeHidden();
  await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(18));
  await expect(page.getByLabel("Message Codex")).toBeVisible();
});

test("Codex icon returns to the persistent empty agent home", async ({ page, boot }) => {
  await boot({
    storage: JSON.stringify({
      version: 1,
      activeId: "thread-1",
      projects: [courses[0]],
      threads: [{
        id: "thread-1", title: "Existing thread", owner: { baseUrl: CURRENT, userId: 101 }, course: courses[0],
        draft: "", resources: [], prompted: true, messages: [{ role: "assistant", text: "Existing answer" }]
      }]
    })
  });
  await page.locator('[data-view="agent"]').click();
  await expect(page.locator("#agent-messages")).toContainText("Existing answer");
  await expect(page.getByLabel("Codex home")).toBeVisible();
  await expect(page.getByLabel("Codex home").locator(".codex-page-icon")).toHaveCount(1);

  await page.getByLabel("Codex home").click();
  await expect(page.locator("#agent-messages .agent-empty-mascot")).toBeVisible();
  await expect(page.locator("#agent-messages")).not.toContainText("Existing answer");
  await expect(page.locator("#agent-messages").getByRole("button", { name: "New Thread", exact: true })).toBeVisible();
  await page.locator('[data-view="courses"]').click();
  await page.locator('[data-view="agent"]').click();
  await expect(page.locator("#agent-messages .agent-empty-mascot")).toBeVisible();
  await expect(page.getByLabel("Message Codex")).toBeHidden();
});

test("mascot sprites animate efficiently for onboarding and active agent work", async ({ page, boot }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await boot({ authenticated: false });
  const onboarding = page.locator(".course-onboarding-mascot");
  await expect(onboarding).toHaveAttribute("role", "img");
  await expect(onboarding).toHaveAttribute("aria-label", "Đậu Đậu, the UIT panda mascot");
  const onboardingStyle = await onboarding.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundImage: style.backgroundImage, animationName: style.animationName, animationDuration: style.animationDuration };
  });
  expect(onboardingStyle.backgroundImage).toContain("dau-dau-onboarding.png");
  expect(onboardingStyle.animationName).toBe("dau-dau-onboarding-frames");
  expect(onboardingStyle.animationDuration).toBe("3.2s");

  await page.evaluate(() => sessionStorage.clear());
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("Check the working mascot");
  await page.locator("#send-agent").click();
  await expect(page.locator("#page-title")).toHaveAttribute("aria-label", "Codex home");
  await expect(page.locator("#page-title .codex-page-icon")).toHaveCount(1);
  const workingStatus = page.locator("#agent-turn-status");
  await expect(workingStatus).toBeVisible();
  await expect(workingStatus).toContainText("Codex is working");
  const workingMascot = workingStatus.locator(".message-turn-state.is-working .working-mascot");
  await expect(workingMascot).toBeVisible();
  const agentStyle = await workingMascot.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundImage: style.backgroundImage, animationName: style.animationName, animationDuration: style.animationDuration };
  });
  expect(agentStyle.backgroundImage).toContain("dau-dau-agent.png");
  expect(agentStyle.animationName).toBe("dau-dau-agent-frames");
  expect(agentStyle.animationDuration).toBe("1.6s");

  const input = (await calls(page, "agent.start"))[0].input;
  const activeParams = { threadId: `thread-${input.taskId}`, taskId: input.taskId, turnId: `turn-${input.taskId}` };
  await emit(page, "item/agentMessage/delta", { ...activeParams, itemId: "answer", delta: "Generated while working" });
  await expect(page.locator("#agent-messages .working-mascot")).toHaveCount(0);
  const messagesBox = await page.locator("#agent-messages").boundingBox();
  const statusBox = await workingStatus.boundingBox();
  expect(messagesBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(statusBox!.y).toBeGreaterThanOrEqual(messagesBox!.y + messagesBox!.height);
  await emit(page, "turn/completed", { threadId: `thread-${input.taskId}`, taskId: input.taskId, turnId: `turn-${input.taskId}`, turn: { id: `turn-${input.taskId}`, status: "completed" } });
  await expect(page.locator(".working-mascot")).toHaveCount(0);
  await expect(workingStatus).toBeHidden();
  await expect(page.locator("#agent-status")).toHaveText("Ready");
});

test("New project groups years clearly and filters the requested year", async ({ page, boot }, info) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await expect(page.locator(".project-year-heading h2")).toHaveText(["2026", "2025", "Unknown year"]);
  await expect(page.locator(".project-year-heading span")).toHaveText(["17 courses", "1 course", "1 course"]);
  await page.getByLabel("Academic year", { exact: true }).selectOption("2025");
  await expect(page.locator(".project-option")).toHaveCount(1);
  await expect(page.locator(".project-option")).toContainText(courses[17].fullname);
  await page.getByLabel("Academic year", { exact: true }).selectOption("Unknown year");
  await expect(page.locator(".project-option")).toContainText(courses[18].fullname);
  await page.getByLabel("Academic year", { exact: true }).selectOption("all");
  await page.screenshot({ path: info.outputPath("project-years.png") });
});

test("academic-year ranges match each year offered by the project filter", async ({ page, boot }) => {
  await boot();
  expect(await page.evaluate(() => (globalThis as any).projectYearMatches({
    semester: { id: "2025-2026", label: "2025-2026" }
  }, "2025"))).toBe(true);
  expect(await page.evaluate(() => (globalThis as any).projectYearMatches({
    semester: { id: "2025-2026", label: "2025-2026" }
  }, "2026"))).toBe(true);
});

test("all semesters default, complete grouped rail, semester filter and search", async ({ page, boot }, info) => {
  await boot();
  await expect(page.getByLabel("Semester", { exact: true })).toHaveValue("all");
  await expect(page.locator("#semester-select option")).toHaveText(["All semesters", ...semesters.map((s) => s.label), "Unknown semester"]);
  await expect(page.locator("#course-nav .semester-nav h3")).toHaveText([...semesters.map((s) => s.label), "Unknown semester"]);
  await expect(page.locator("#course-nav .project")).toHaveCount(19);
  await expect(page.locator(".course-row")).toHaveCount(19);
  await expect(page.locator(".course-row").last()).toContainText("Computer science 19");
  await page.screenshot({ path: info.outputPath("desktop-courses.png"), fullPage: true });
  await page.getByRole("searchbox").fill("  Legacy Moodle ");
  await expect(page.locator(".course-row")).toHaveCount(5);
  await expect(page.locator("#course-grid .section-label")).toHaveText([...semesters.map((s) => s.label), "Unknown semester"]);
  await page.getByRole("searchbox").fill("cs13");
  await expect(page.locator(".course-row")).toHaveCount(1);
  await expect(page.locator(".course-row")).toContainText("Computer science 13");
  await page.getByLabel("Semester", { exact: true }).selectOption(semesters[1].id);
  await expect(page.locator(".course-row")).toHaveCount(1);
  await expect(page.locator(".course-row")).toContainText("Computer science 13");
  await expect(page.locator("#course-grid .list-heading h2")).toHaveText("Search across all semesters");
  await page.getByRole("searchbox").fill("");
  await expect(page.locator(".course-row")).toHaveCount(2);
  await page.getByLabel("Semester", { exact: true }).selectOption("all");
  await expect(page.locator(".course-row")).toHaveCount(19);
  await expect(page.locator("#course-grid .section-label")).toHaveText([...semesters.map((s) => s.label), "Unknown semester"]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".course-row")).toHaveCount(19);
  await expect(page.getByLabel("Semester", { exact: true })).toHaveValue("all");
  await page.getByLabel("Semester", { exact: true }).selectOption("unknown");
  await expect(page.locator(".course-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Semester", { exact: true })).toHaveValue("unknown");
  expect(await calls(page, "courses.refresh")).toHaveLength(2);
  await expect(page.locator("#account-label")).toHaveText("Course accounts (2)");
});

test("Codex projects are explicitly selected, persist empty and new threads choose existing projects only", async ({ page, boot }) => {
  await boot();
  await expect(page.locator("#new-task")).toBeHidden();
  await openCourse(page);
  await expect(page.locator("#new-task")).toBeHidden();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#new-task")).toHaveCount(0);
  await expect(page.locator("#new-project")).toBeVisible();
  await expect(page.locator("#course-nav .project")).toHaveCount(0);
  await expect(page.locator("#course-nav .rail-empty")).toHaveText("No projects");
  const saved = await page.evaluate((store) => localStorage.getItem(store), STORE);
  for (const cancel of ["button", "Escape"]) {
    await page.locator("#new-project").click();
    await expect(page.getByRole("dialog", { name: "New project", exact: true })).toBeVisible();
    await expect(page.locator("#project-search")).toBeFocused();
    await expect(page.locator("#project-picker")).toHaveAttribute("data-mode", "project");
    await expect(page.locator(".project-option")).toHaveCount(19);
    await expect(page.locator("#picker-new-project")).toHaveCount(0);
    await expect(page.locator(".thread-link")).toHaveCount(0);
    expect(await page.evaluate((store) => localStorage.getItem(store), STORE)).toBe(saved);
    if (cancel === "button") await page.getByRole("button", { name: "Cancel new thread" }).click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("#project-picker")).toBeHidden();
    await expect(page.locator("#new-project")).toBeFocused();
    await expect(page.locator(".thread-link")).toHaveCount(0);
    expect(await page.evaluate((store) => localStorage.getItem(store), STORE)).toBe(saved);
  }
  await page.locator("#new-project").click();
  await expect(page.getByRole("dialog", { name: "New project", exact: true })).toBeVisible();
  await expect(page.locator("#project-picker")).toHaveAttribute("data-mode", "project");
  await expect(page.locator("#picker-new-project")).toHaveCount(0);
  await expect(page.locator("#project-options h3")).toHaveText([...semesters.map((s) => s.label), "Unknown semester"]);
  await expect(page.locator(".project-option")).toHaveCount(19);
  await page.locator(".project-option").filter({ hasText: "Legacy algorithms" }).click();
  await expect(page.locator("#project-picker")).toBeHidden();
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await expect(page.locator("#course-nav .project")).toHaveCount(1);
  await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(14));
  await expect(page.getByLabel("Message Codex")).toBeFocused();
  await expect(page.getByLabel("Message Codex")).toHaveValue("");
  await expect(page.locator("#send-agent")).toBeDisabled();
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored).toMatchObject({ version: 1, activeId: null, threads: [] });
  expect(stored.projects).toHaveLength(1);
  expect(stored.projects[0]).toMatchObject({ id: 1, baseUrl: LEGACY, userId: 202 });
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#course-nav .project")).toHaveCount(1);
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await expect(page.getByLabel("Message Codex")).toBeDisabled();
  await createThread(page, 14);
  await expect(page.locator("#project-picker")).toBeHidden();
  await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(14));
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await page.locator("#new-project").click();
  await expect(page.locator("#project-picker")).toHaveAttribute("data-mode", "project");
  await expect(page.locator(".project-option")).toHaveCount(18);
  await expect(page.locator(".project-option").filter({ hasText: "Legacy algorithms" })).toHaveCount(0);
  for (const method of ["agent.start", "agent.send", "workspace.create", "courses.materialize"]) expect(await calls(page, method)).toHaveLength(0);
});

test("project search, empty results and cancellation preserve the active resource draft", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "Actions for lecture.txt", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Thread" }).click();
  await expect(page.locator("#project-picker")).toBeHidden();
  await page.getByLabel("Message Codex").fill("Keep my attached lecture draft");
  const saved = await page.evaluate((store) => localStorage.getItem(store), STORE);
  expect(JSON.parse(saved!).threads).toEqual([]);
  for (const cancel of ["button", "Escape"]) {
    await page.locator("#new-project").click();
    await expect(page.locator("#project-picker")).toBeVisible();
    await expect(page.locator("#project-search")).toHaveValue("");
    for (const [query, count] of [["  Legacy Moodle ", 5], ["cs13", 1], ["Computer science 18", 1], ["missing-project-xyz", 0]] as const) {
      await page.getByLabel("Search projects", { exact: true }).fill(query);
      await expect(page.locator(".project-option")).toHaveCount(count);
      if (query === "cs13") await expect(page.locator(".project-option")).toContainText("Computer science 13");
      if (query === "Computer science 18") await expect(page.locator("#project-options h3")).toHaveText([semesters[2].label]);
    }
    await expect(page.locator("#project-options")).toHaveText("No available courses");
    expect(await page.evaluate((store) => localStorage.getItem(store), STORE)).toBe(saved);
    if (cancel === "button") await page.getByRole("button", { name: "Cancel new thread" }).click();
    else {
      await page.getByRole("button", { name: "Cancel new thread" }).focus();
      await page.keyboard.press("Escape");
    }
    await expect(page.locator("#project-picker")).toBeHidden();
    await expect(page.locator("#new-project")).toBeFocused();
    await expect(page.locator(".thread-link")).toHaveCount(0);
    await expect(page.getByLabel("Message Codex")).toHaveValue("Keep my attached lecture draft");
    await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(0));
    await expect(page.locator("#resource-chips")).toContainText("@lecture.txt");
    expect(await page.evaluate((store) => localStorage.getItem(store), STORE)).toBe(saved);
  }
  await page.locator("#new-project").click();
  await page.locator(".project-option").filter({ hasText: "Legacy algorithms" }).click();
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await expect(page.locator("#course-nav .project")).toHaveCount(2);
  await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(14));
  await expect(page.locator("#resource-chips .resource-chip")).toHaveCount(0);
  await page.getByRole("button", { name: "CS01", exact: true }).click();
  await expect(page.getByLabel("Message Codex")).toHaveValue("");
  await expect(page.locator("#resource-chips .resource-chip")).toHaveCount(0);
  expect(JSON.parse((await page.evaluate((store) => localStorage.getItem(store), STORE))!).threads).toEqual([]);
  for (const method of ["agent.start", "agent.send", "workspace.create", "courses.materialize"]) expect(await calls(page, method)).toHaveLength(0);
});

test("global search finds an unknown-semester thesis without changing the semester filter", async ({ page, boot }) => {
  await boot();
  await page.getByLabel("Semester", { exact: true }).selectOption(semesters[0].id);
  await page.evaluate(() => {
    const refresh = window.uit.courses.refresh;
    window.uit.courses.refresh = async () => (await refresh()).map((course: any) => course.id === 19 ? { ...course, fullname: "Graduation thesis", shortname: "THESIS", semester: undefined } : course);
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".course-row")).toHaveCount(15);
  await page.getByRole("searchbox", { name: "Search courses", exact: true }).fill("  THESIS  ");
  await expect(page.locator(".course-row")).toHaveCount(1);
  await expect(page.locator(".course-row")).toContainText("Graduation thesis");
  await expect(page.locator("#course-grid .section-label")).toHaveText(["Unknown semester"]);
  await expect(page.getByLabel("Semester", { exact: true })).toHaveValue(semesters[0].id);
  await page.getByRole("searchbox", { name: "Search courses", exact: true }).fill("missing-thesis-xyz");
  await expect(page.locator(".course-row")).toHaveCount(0);
  await expect(page.locator("#course-grid .empty")).toHaveText("No matching courses");
  await page.getByRole("searchbox", { name: "Search courses", exact: true }).fill("");
  await expect(page.locator(".course-row")).toHaveCount(15);
  await page.getByLabel("Semester", { exact: true }).selectOption("all");
  await expect(page.locator(".course-row")).toHaveCount(19);
  await expect(page.locator(".course-row").last()).toContainText("Graduation thesis");
});

for (const destination of ["Courses", "another project", "another thread", "new thread", "reload"] as const) {
  test(`typed temporary thread is discarded on ${destination} without storing or counting it`, async ({ page, boot }) => {
    await boot();
    await openCourse(page);
    await page.getByRole("button", { name: "New Thread", exact: true }).click();
    await sendAndStop(page, "Existing saved thread");
    await page.getByLabel("Message Codex").fill("Existing follow-up draft");
    await createThread(page);
    await page.getByLabel("Message Codex").fill("Temporary typed content must disappear");
    await expect(page.locator(".thread-link")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.eval("draftPersistTimer"))).toBeNull();
    const temporary = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
    expect(temporary.activeId).toBeNull();
    expect(temporary.threads).toHaveLength(1);
    expect(JSON.stringify(temporary)).not.toContain("Temporary typed content");
    if (destination === "Courses") await page.locator('.nav-item[data-view="courses"]').click();
    else if (destination === "another project") {
      await page.locator("#new-project").click();
      await page.locator(".project-option").filter({ hasText: "Legacy algorithms" }).click();
      await expect(page.getByLabel("Message Codex")).toHaveValue("");
    } else if (destination === "another thread") await page.locator(".thread-link").click();
    else if (destination === "new thread") {
      await createThread(page);
      await expect(page.getByLabel("Message Codex")).toHaveValue("");
    } else await page.reload();
    await page.locator('.nav-item[data-view="agent"]').click();
    await expect(page.locator(".thread-link")).toHaveCount(1);
    await page.locator(".thread-link").click();
    await expect(page.getByLabel("Message Codex")).toHaveValue("Existing follow-up draft");
    const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
    expect(stored.threads).toHaveLength(1);
    expect(stored.threads[0]).toMatchObject({ prompted: true, draft: "Existing follow-up draft" });
    expect(JSON.stringify(stored)).not.toContain("Temporary typed content");
    expect(await page.evaluate(() => window.eval("state.threads.length"))).toBe(1);
  });
}

test("restore filters old unprompted and transient inherited histories but migrates sent projects", async ({ page, boot }) => {
  const thread = (id: string, index: number, extra = {}) => ({
    id, title: id, course: courses[index], draft: `Draft for ${id}`, resources: [], messages: [], renamed: true, ...extra,
  });
  await boot({ storage: JSON.stringify({ version: 1, activeId: "old-typed", threads: [
    thread("old-typed", 1),
    thread("old-event-only", 2, { messages: [{ role: "event", text: "Not a prompt" }] }),
    thread("old-sent", 0, { messages: [{ role: "user", text: "Previously sent" }, { role: "assistant", text: "Saved answer" }] }),
    thread("failed-prompt", 14, { prompted: true, messages: [{ role: "event", text: "Old failure" }] }),
    thread("transient-branch", 3, { prompted: false, messages: [{ role: "user", text: "Inherited only" }] }),
  ] }) });
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#course-nav .project")).toHaveCount(2);
  await expect(page.locator(".thread-link")).toHaveCount(2);
  await expect(page.locator("#course-nav")).not.toContainText("old-typed");
  await expect(page.locator("#course-nav")).not.toContainText("transient-branch");
  await page.locator(".thread-link").filter({ hasText: "old-sent" }).click();
  await expect(page.locator("#agent-messages")).toContainText("Saved answer");
  await expect(page.getByLabel("Message Codex")).toHaveValue("Draft for old-sent");
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored.version).toBe(1);
  expect(stored.threads.map((thread: any) => [thread.id, thread.prompted])).toEqual([["old-sent", true], ["failed-prompt", true]]);
  expect(stored.projects.map((project: any) => [project.baseUrl, project.userId, project.id])).toEqual([[CURRENT, 101, 1], [LEGACY, 202, 1]]);
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".thread-link")).toHaveCount(2);
  await expect(page.locator("#course-nav .project")).toHaveCount(2);
  for (const method of ["agent.start", "agent.send", "agent.fork"]) expect(await calls(page, method)).toHaveLength(0);
});

test("branch history stays transient until first send, then forks once and persists", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "Source conversation");
  await page.getByLabel("Message Codex").fill("Source follow-up");
  const source = (await calls(page, "agent.start"))[0].input;
  for (const destination of ["Courses", "source thread", "reload"] as const) {
    await branchThread(page);
    await expect(page.locator("#agent-task-title")).toHaveText("Branch: Source conversation");
    await expect(page.locator("#agent-messages")).toContainText("Source conversation");
    await expect(page.getByLabel("Message Codex")).toHaveValue("Source follow-up");
    await page.getByLabel("Message Codex").fill("Discard this branch draft");
    await expect(page.locator(".thread-link")).toHaveCount(1);
    expect(await page.evaluate(() => window.eval("({ prompted: activeThread().prompted, renamed: activeThread().renamed })"))).toEqual({ prompted: false, renamed: true });
    await expect.poll(() => page.evaluate(() => window.eval("draftPersistTimer"))).toBeNull();
    const temporary = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
    expect(temporary.threads).toHaveLength(1);
    expect(JSON.stringify(temporary)).not.toContain("Branch: Source conversation");
    expect(await calls(page, "agent.fork")).toHaveLength(0);
    if (destination === "Courses") await page.locator('.nav-item[data-view="courses"]').click();
    else if (destination === "source thread") await page.locator(".thread-link").click();
    else await page.reload();
    await page.locator('.nav-item[data-view="agent"]').click();
    await page.locator(".thread-link").click();
    await expect(page.getByLabel("Message Codex")).toHaveValue("Source follow-up");
    const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
    expect(stored.threads).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("Discard this branch draft");
  }
  await branchThread(page);
  await control(page, "hold", "agent.fork");
  await page.getByLabel("Message Codex").fill("First branch prompt");
  await page.locator("#send-agent").click();
  await expect(page.locator(".thread-link")).toHaveCount(2);
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored.threads[0]).toMatchObject({ prompted: true, title: "Branch: Source conversation", forkSource: `thread-${source.taskId}` });
  expect(stored.threads[0].messages.filter((message: any) => message.role === "user").map((message: any) => message.text)).toEqual(["Source conversation", "First branch prompt"]);
  expect((await calls(page, "agent.fork"))[0].input).toEqual({ threadId: `thread-${source.taskId}` });
  expect(await calls(page, "agent.send")).toHaveLength(0);
  await control(page, "release", "agent.fork");
  await page.locator("#stop-agent").click();
  expect((await calls(page, "agent.send"))[0].input).toMatchObject({ threadId: `branch-thread-${source.taskId}`, message: "First branch prompt" });
  await sendAndStop(page, "Second branch prompt");
  expect(await calls(page, "agent.fork")).toHaveLength(1);
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".thread-link")).toHaveCount(2);
  await expect(page.locator("#agent-messages")).toContainText("Second branch prompt");
  for (const method of ["agent.start", "agent.send", "agent.fork"]) expect(await calls(page, method)).toHaveLength(0);
});

test("failed deferred fork persists its prompt and source for retry after reload", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "Source for retry");
  const source = (await calls(page, "agent.start"))[0].input;
  await branchThread(page);
  await control(page, "fail", "agent.fork", "Fixture fork unavailable");
  await page.getByLabel("Message Codex").fill("Retry branch prompt");
  await page.locator("#send-agent").click();
  await expect(page.locator("#agent-messages")).toContainText("Fixture fork unavailable");
  await expect(page.locator(".thread-link")).toHaveCount(2);
  expect(await calls(page, "agent.send")).toHaveLength(0);
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored.threads[0]).toMatchObject({ prompted: true, forkSource: `thread-${source.taskId}`, threadId: null, draft: "Retry branch prompt" });
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.getByLabel("Message Codex")).toHaveValue("Retry branch prompt");
  expect(await calls(page, "agent.fork")).toHaveLength(0);
  await page.locator("#send-agent").click();
  await page.locator("#stop-agent").click();
  expect((await calls(page, "agent.fork"))[0].input).toEqual({ threadId: `thread-${source.taskId}` });
  expect((await calls(page, "agent.send"))[0].input).toMatchObject({ threadId: `branch-thread-${source.taskId}`, message: "Retry branch prompt" });
  expect(await calls(page, "agent.start")).toHaveLength(0);
});

for (const selected of ["older", "all"] as const) {
  test(`legacy-first then SSO shows undated thesis with ${selected} previous filter`, async ({ page, boot }) => {
    await boot({ authenticated: false });
    await page.evaluate(({ legacy, semester }) => {
      const list = window.uit.courses.list;
      window.uit.courses.list = async () => (await list()).map((course: any) => course.baseUrl === legacy && course.semester ? { ...course, semester } : course.baseUrl !== legacy && course.id === 1 ? { ...course, id: 807, shortname: "AI505.R11", fullname: "Khoá luận tốt nghiệp - AI505.R11", semester: undefined } : course);
    }, { legacy: LEGACY, semester: semesters[1] });
    await page.getByRole("button", { name: "Connect UIT account", exact: true }).click();
    await page.getByLabel("Student ID", { exact: true }).fill("202");
    await page.getByLabel("Password", { exact: true }).fill("fixture-only-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator("#semester-select")).toHaveValue("all");
    await expect(page.locator("#session-summary")).toContainText("Account 202");
    await page.getByRole("button", { name: "Close accounts" }).click();
    await expect(page.locator(".course-row")).toHaveCount(5);
    if (selected === "older") await page.getByLabel("Semester", { exact: true }).selectOption(semesters[1].id);
    await page.locator("#account-button").click();
    await page.getByRole("button", { name: "Continue with UIT SSO" }).click();
    await expect(page.locator("#session-summary .session-row")).toHaveCount(2);
    await expect(page.locator("#session-summary")).toContainText("UIT SSO");
    await expect(page.locator("#session-summary")).toContainText("Student ID");
    await expect(page.locator("#semester-select")).toHaveValue("all");
    await page.getByRole("button", { name: "Close accounts" }).click();
    await expect(page.locator(".course-row")).toHaveCount(19);
    await expect(page.locator("#course-grid")).toContainText("Khoá luận tốt nghiệp - AI505.R11");
    await expect(page.locator("#course-nav .project")).toHaveCount(19);
    await page.getByLabel("Semester", { exact: true }).selectOption(semesters[1].id);
    await expect(page.locator(".course-filter-notice")).toContainText("15 courses in other or unknown semesters are hidden.");
    await page.getByRole("button", { name: "Show all semesters", exact: true }).click();
    await expect(page.locator(".course-row")).toHaveCount(19);
    await expect(page.locator(".course-filter-notice")).toHaveCount(0);
    expect((await calls(page, "session.ssoLogin"))[0].input).toEqual({ baseUrl: CURRENT });
  });
}

test("duplicate numeric course IDs keep portal and account references separate", async ({ page, boot }) => {
  await boot();
  for (const index of [0, 14]) {
    await openCourse(page, index);
    for (const method of ["contents", "assignments", "announcements"]) {
      expect((await calls(page, `courses.${method}`)).at(-1)?.input).toEqual({ courseId: 1, baseUrl: courses[index].baseUrl, userId: courses[index].userId });
    }
    await page.getByRole("button", { name: "New Thread", exact: true }).click();
    await expect(page.locator("#project-picker")).toBeHidden();
    await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(index));
  }
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await expect(page.locator("#course-nav .project")).toHaveCount(2);
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored.projects.map((project: any) => [project.baseUrl, project.userId, project.id])).toEqual([[CURRENT, 101, 1], [LEGACY, 202, 1]]);
  expect(stored.threads).toEqual([]);
  expect(await calls(page, "agent.start")).toHaveLength(0);
});

for (const file of fileTypes) {
  test(`preview ${file.filename} is in memory, never materialized or opened`, async ({ page, boot }) => {
    await boot();
    await openCourse(page);
    if (["lecture.txt", "notes.html", "data.json", "diagram.svg", "archive.zip"].includes(file.filename)) {
      await expect(page.locator("#contents-panel .file-row").filter({ hasText: file.filename })).toContainText("Download to view");
      await page.locator("#contents-panel .resource-open").filter({ hasText: file.filename }).click();
      await expect(page.getByRole("dialog", { name: file.filename, exact: true })).toBeVisible();
      await expect(page.locator("#reader-body")).toContainText("can't be previewed in UIT Studio");
      await expect(page.locator("#reader-body")).not.toContainText("could not be loaded");
      await expect(page.locator("#reader-download")).toBeVisible();
      await expect(page.locator("#reader-download")).toBeEnabled();
      expect(await calls(page, "courses.preview")).toHaveLength(0);
      for (const method of ["courses.materialize", "courses.open", "shell.open", "workspace.create", "agent.start"]) expect(await calls(page, method)).toHaveLength(0);
      await page.getByRole("button", { name: "Close preview" }).click();
      await expect(page.locator("#reader-body")).toBeEmpty();
      return;
    }
    await page.locator("#contents-panel .resource-open").filter({ hasText: file.filename }).click();
    await expect(page.getByRole("dialog", { name: file.filename, exact: true })).toBeVisible();
    const body = page.locator("#reader-body");
    if (file.filename === "slide.pdf") {
      await expect(body.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
      await expect(body.locator('.pdf-page[data-page="1"] canvas')).toBeVisible();
      await expect(body.locator(".pdf-page")).toHaveCount(2);
      await expect(body.locator("iframe")).toHaveCount(0);
      await expect(body.locator('.pdf-page[data-page="1"] .pdf-text')).toContainText("UIT OFFLINE PDF PAGE 1");
    } else if (file.filename === "pixel.png") {
      await expect(body.getByRole("img", { name: file.filename })).toBeVisible();
      await expect.poll(() => body.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    } else if (["script.py", "readme.md", "essay.docx"].includes(file.filename)) {
      await expect(body.locator("pre")).toHaveText(file.text!);
      await expect(body.locator("script, h1")).toHaveCount(0);
    } else await expect(body).toContainText("This file has not been saved or opened");
    expect(await page.evaluate(() => window.previewExecuted)).toBeUndefined();
    expect((await calls(page, "courses.preview"))[0].input).toMatchObject({ courseId: 1, baseUrl: CURRENT, userId: 101, filename: file.filename });
    for (const method of ["courses.materialize", "courses.open", "shell.open", "workspace.create", "agent.start"]) expect(await calls(page, method)).toHaveLength(0);
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(page.locator("#reader-body")).toBeEmpty();
  });
}

test("type scale, chevrons and nesting guides", async ({ page, boot }, info) => {
  await boot();
  await expect(page.locator("html")).toHaveCSS("font-size", "16px");
  await expect(page.locator("#course-nav .project .folder svg")).toHaveCount(0);
  await expect(page.locator("#rail-title")).toHaveCount(0);
  await expect(page.locator("#show-archived")).toHaveCount(0);
  await expect(page.locator("#course-nav .semester-nav > h3").first()).toHaveCSS("font-size", "17px");
  await expect(page.locator("#course-nav .semester-nav").first()).toHaveCSS("border-top-width", "1px");
  await openCourse(page);
  await expect(page.locator("#contents-panel .file-row").first()).toHaveCSS("padding-left", "36px");
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();
  await sendAndStop(page, "Prompt for nesting");
  await expect(page.locator("#course-nav .thread-list")).toHaveCount(1);
  await expect(page.locator("#course-nav .thread-list").first()).toHaveCSS("border-left-width", "0px");
  await expect(page.locator("#course-nav .thread-row").first()).toHaveCSS("padding-left", "16px");
  await expect(page.locator("#course-nav .project.expanded .project-collapse svg")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("nesting.png") });
  for (const method of ["courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

test("composer shows course context and a working model/effort picker", async ({ page, boot }) => {
  await boot();
  await createThread(page);
  await expect(page.locator("#composer-context")).toContainText("CS01");
  await expect(page.locator("#composer-context")).not.toContainText("Workspace write");
  await expect(page.locator("#model-picker")).toContainText("Auto");
  await expect(page.locator("#model-picker")).not.toContainText("⚡");
  await page.locator("#model-picker").click();
  await expect(page.locator("#model-menu")).toContainText("GPT-5.6-Sol");
  await page.locator(".model-option").filter({ hasText: "GPT-5.6-Sol" }).click();
  await expect(page.locator("#model-picker")).toContainText("GPT-5.6-Sol");
  await page.locator("#model-picker").click();
  await page.locator(".model-option").filter({ hasText: "high" }).click();
  await expect(page.locator("#model-picker")).toContainText("high");
  await expect(page.locator("#model-menu")).toBeHidden();
  await sendAndStop(page, "Model picker prompt");
  expect((await calls(page, "agent.start")).at(-1)!.input).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  for (const method of ["courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

test("@-mention popup attaches course files as chips without sending", async ({ page, boot }) => {
  await boot();
  await createThread(page);
  await page.getByLabel("Message Codex").fill("Summarize @script");
  await expect(page.locator("#mention-list .mention-item")).toHaveCount(1);
  await expect(page.locator("#mention-list .mention-item")).toContainText("script.py");
  await page.locator("#mention-list .mention-item").first().click();
  await expect(page.locator(".resource-chip")).toContainText("@script.py");
  await expect(page.getByLabel("Message Codex")).toHaveValue("Summarize ");
  await expect(page.locator("#mention-list")).toBeHidden();
  await page.getByLabel("Message Codex").fill("Hello @rea");
  await expect(page.locator("#mention-list .mention-item")).toContainText("readme.md");
  await page.getByLabel("Message Codex").press("Escape");
  await expect(page.locator("#mention-list")).toBeHidden();
  await page.locator("#send-agent").click();
  expect((await calls(page, "agent.start")).at(-1)!.input.resources).toEqual([{ kind: "file", id: 502, fileUrl: expect.stringContaining("script.py") }]);
  await page.locator("#stop-agent").click();
  await expect(page.locator("#agent-status")).toHaveText("Ready");
  for (const method of ["courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

test("project chevron collapses and expands its thread list", async ({ page, boot }) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();
  await sendAndStop(page, "Collapsible threads");
  await expect(page.locator("#course-nav .thread-list")).toHaveCount(1);
  const toggle = page.locator("#course-nav .project-collapse").first();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(page.locator("#course-nav .thread-list")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator("#course-nav .thread-list")).toHaveCount(1);
  for (const method of ["courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

test("tool calls keep one typed lifecycle row and collapse completed output", async ({ page, boot }) => {
  await boot();
  await createThread(page);
  await sendAndStop(page, "Run a command");
  const threadId = await page.evaluate(() => JSON.parse(localStorage.getItem("uit-studio.threads.v1")!).threads[0].threadId);
  await page.evaluate((id) => {
    window.__mock.emit({ method: "item/started", params: { threadId: id, item: { id: "call-1", type: "commandExecution", command: "ls /tmp" } } });
    window.__mock.emit({ method: "item/commandExecution/outputDelta", params: { threadId: id, itemId: "call-1", delta: "full output line 1\n" } });
    window.__mock.emit({ method: "item/completed", params: { threadId: id, item: { id: "call-1", type: "commandExecution", command: "ls /tmp", exitCode: 0, output: "full output line 1\nfull output line 2" } } });
  }, threadId);
  const tool = page.locator('[data-kind="tool"]');
  await expect(tool).toHaveCount(1);
  await expect(tool).toHaveAttribute("data-status", "completed");
  await expect(tool.locator("summary")).toHaveText("Ran ls /tmp · exit 0");
  await expect(tool.locator("pre")).toBeHidden();
  await expect(tool.locator("pre")).toContainText("full output line 1");
  await tool.locator("summary").click();
  await expect(tool.locator("pre")).toBeVisible();
});

test("codex file citations render as links that open the workspace file", async ({ page, boot }) => {
  await boot();
  await createThread(page);
  await sendAndStop(page, "Read the syllabus");
  const threadId = await page.evaluate(() => JSON.parse(localStorage.getItem("uit-studio.threads.v1")!).threads[0].threadId);
  const cited = "See Nguồn: :codex-file-citation{path=\"/tmp/syllabus.pdf\" purpose=\"source\"} for details";
  await page.evaluate(({ id, text }) => {
    window.__mock.emit({ method: "item/agentMessage/delta", params: { threadId: id, itemId: "m-1", delta: "See Nguồn: :codex-file-" } });
    window.__mock.emit({ method: "item/completed", params: { threadId: id, item: { id: "m-1", type: "agentMessage", text } } });
  }, { id: threadId, text: cited });
  const link = page.locator(".citation-link");
  await expect(link).toHaveText("syllabus.pdf");
  await expect(page.locator("#agent-messages")).not.toContainText("codex-file-citation");
  await expect(page.locator("#agent-messages")).not.toContainText("Nguồn:");
  await page.evaluate(() => {
    (window as any).__shellOpened = null;
    window.uit.shell.open = async (target: string) => { (window as any).__shellOpened = target; return ""; };
  });
  await link.click();
  expect(await page.evaluate(() => (window as any).__shellOpened)).toBe("/tmp/syllabus.pdf");
});

test("streaming respects history reading and jump to latest resumes following", async ({ page, boot }) => {
  await boot();
  await page.setViewportSize({ width: 900, height: 560 });
  await createThread(page);
  await page.getByLabel("Message Codex").fill("Build a long timeline");
  await page.locator("#send-agent").click();
  const input = (await calls(page, "agent.start"))[0].input;
  const threadId = `thread-${input.taskId}`;
  await page.evaluate((id) => {
    for (let index = 0; index < 24; index++) window.__mock.emit({ method: "item/completed", params: { threadId: id, item: { id: `history-${index}`, type: "agentMessage", text: `History ${index}\n${"detail ".repeat(30)}` } } });
  }, threadId);
  const box = page.locator("#agent-messages");
  await expect.poll(() => box.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await box.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await emit(page, "item/agentMessage/delta", { threadId, itemId: "latest", delta: "Latest streaming answer" });
  await expect(page.locator("#jump-to-latest")).toBeVisible();
  expect(await box.evaluate((element) => element.scrollTop)).toBe(0);
  await page.locator("#jump-to-latest").click();
  await expect.poll(() => box.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3);
  await expect(page.locator("#jump-to-latest")).toBeHidden();
});

test("IME composition cannot send or select a resource mention", async ({ page, boot }) => {
  await boot();
  await createThread(page);
  const input = page.getByLabel("Message Codex");
  await input.fill("Explain @scr");
  await expect(page.locator("#mention-list")).toBeVisible();
  await input.dispatchEvent("compositionstart", { data: "" });
  await expect(page.locator("#mention-list")).toBeHidden();
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  expect(await calls(page, "agent.start")).toHaveLength(0);
  await expect(page.locator(".resource-chip")).toHaveCount(0);
  await input.dispatchEvent("compositionend", { data: "" });
  await expect(input).toHaveValue("Explain @scr");
  await expect(input).toHaveAttribute("aria-describedby", "agent-status");
});

test("multi-file modules, all assignments and all announcements are readable", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await expect(page.locator("#contents-panel .section-label")).toHaveText(["Week 1", "Week 2"]);
  await expect(page.locator('#contents-panel [data-resource-kind="module"]')).toHaveCount(2);
  await expect(page.locator("#assignment-list .resource-row")).toHaveCount(7);
  await expect(page.locator("#announcement-list .resource-row")).toHaveCount(6);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "Week 2 materials" }).click();
  await expect(page.locator("#reader-body")).toContainText("Second module introduction");
  await expect(page.locator("#reader-body .file-row")).toHaveCount(7);
  await page.locator("#reader-body .resource-open").filter({ hasText: "script.py" }).click();
  await expect(page.locator("#reader-body pre")).toHaveText("print('hello from memory')");
  await page.getByRole("button", { name: "Close preview" }).click();
  for (const [panel, count, label] of [["assignment-list", 7, "assignment"], ["announcement-list", 6, "announcement"]] as const) {
    for (let index = 0; index < count; index++) {
      await page.locator(`#${panel} .resource-open`).nth(index).click();
      await expect(page.locator("#reader-body")).toContainText(`Full ${label} ${index + 1}:`);
      await expect(page.locator("#reader-download")).toBeHidden();
      await expect(page.locator("#reader-body script")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.locator("#resource-reader")).not.toBeVisible();
    }
  }
  expect(await calls(page, "courses.preview")).toHaveLength(1);
  expect(await calls(page, "courses.materialize")).toHaveLength(0);
});

test("explicit overflow and reader downloads save only the selected file; Moodle open is explicit", async ({ page, boot }) => {
  await boot();
  await openCourse(page, 14);
  const row = page.locator("#contents-panel .file-row").filter({ hasText: "lecture.txt" });
  await expect(page.locator(".resource-row .download-button")).toHaveCount(0);
  await expect(page.locator(".resource-row").getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await row.getByRole("button", { name: "Actions for lecture.txt", exact: true }).click();
  await expect(page.locator("#resource-menu-preview")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Saved to");
  expect((await calls(page, "courses.materialize"))[0].input).toEqual({ courseId: 1, baseUrl: LEGACY, userId: 202, filename: "lecture.txt", shortname: "LEGACY-CS01", fileUrl: `${LEGACY}/pluginfile.php/1/0/lecture.txt` });
  expect(await calls(page, "courses.preview")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await row.locator(".resource-open").click();
  await page.locator("#reader-download").click();
  await expect(page.locator("#reader-status")).toContainText("Saved to /fixture/downloads/lecture.txt");
  expect(await calls(page, "courses.materialize")).toHaveLength(2);
  expect(await calls(page, "shell.open")).toHaveLength(0);
  await page.locator("#reader-moodle").click();
  expect((await calls(page, "courses.open"))[0].input).toMatchObject({ courseId: 1, baseUrl: LEGACY, userId: 202 });
});

test("news forums covered by announcements are not repeated in materials", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await expect(page.locator("#announcement-list .resource-row")).toHaveCount(6);
  await expect(page.locator("#contents-panel .resource-open").filter({ hasText: "Class announcements" })).toHaveCount(0);
  await page.locator("#announcement-list .resource-open").first().click();
  await expect(page.locator("#reader-body")).toContainText("Full announcement 1: classroom schedule and reading.");
  for (const method of ["courses.materialize", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

for (const [kind, name, id] of [["module", "Week 1 materials", 501], ["file", "lecture.txt", 501], ["assignment", "Assignment 7", 607], ["announcement", "Announcement 6", 806]] as const) {
  for (const interaction of ["right click", "keyboard"] as const) {
    test(`${interaction} ${kind} context creates correct tagged unsent project thread`, async ({ page, boot }) => {
      await boot();
      await openCourse(page, 14);
      const row = page.locator(`#course-detail [data-resource-kind="${kind}"]`).filter({ hasText: name });
      if (interaction === "right click") await row.click({ button: "right" });
      else { await row.getByRole("button", { name: `Actions for ${name}`, exact: true }).focus(); await page.keyboard.press("Enter"); }
      await expect(page.getByRole("menuitem", { name: "New Thread" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.locator("#resource-menu-preview")).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "Preview", exact: true })).toHaveCount(0);
      if (kind === "file") {
        await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toBeFocused();
        await expect(page.getByRole("menuitem")).toHaveCount(2);
      } else {
        await expect(page.locator("#resource-menu-download")).toBeHidden();
        await expect(page.getByRole("menuitem")).toHaveCount(1);
        await expect(page.getByRole("menuitem", { name: "New Thread" })).toBeFocused();
      }
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await expect(page.locator("#view-agent")).toBeVisible();
      await expect(page.locator("#project-picker")).toBeHidden();
      await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(14));
      await expect(page.locator("#resource-chips")).toContainText(`@${name}`);
      await expect(page.locator("#resource-chips .resource-chip")).toHaveAttribute("data-resource-kind", kind);
      await expect(page.getByLabel("Message Codex")).toHaveValue("");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
      expect(stored.threads).toEqual([]);
      expect(stored.projects).toHaveLength(1);
      expect(stored.projects[0]).toMatchObject({ id: 1, baseUrl: LEGACY, userId: 202 });
      await expect(page.locator(".thread-link")).toHaveCount(0);
      const resource = await page.evaluate(() => window.eval("activeThread().resources[0]"));
      expect(resource).toMatchObject({ kind, id, name });
      for (const method of ["agent.start", "agent.send", "courses.materialize", "workspace.create"]) expect(await calls(page, method)).toHaveLength(0);
    });
  }
}

test("sent project threads persist follow-up drafts, rename, delete and switch independently", async ({ page, boot }, info) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "First saved conversation");
  await page.getByLabel("Message Codex").fill("Draft one\nwith a second line");
  await page.locator("#agent-task-title").dblclick();
  await page.getByLabel("Thread name").fill("Exam preparation");
  await page.getByRole("button", { name: "Save name" }).click();
  await createThread(page);
  await expect(page.locator("#project-picker")).toBeHidden();
  await sendAndStop(page, "Second saved conversation");
  await page.getByLabel("Message Codex").fill("Independent second draft");
  await page.locator(".thread-link").filter({ hasText: "Exam preparation" }).click();
  await expect(page.getByLabel("Message Codex")).toHaveValue("Draft one\nwith a second line");
  await page.screenshot({ path: info.outputPath("desktop-agent.png"), fullPage: true });
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#agent-task-title")).toHaveText("Exam preparation");
  await expect(page.getByLabel("Message Codex")).toHaveValue("Draft one\nwith a second line");
  await expect(page.locator(".thread-link")).toHaveCount(2);
  await page.locator(".thread-link").filter({ hasText: "Second saved conversation" }).click();
  await expect(page.getByLabel("Message Codex")).toHaveValue("Independent second draft");
  await page.locator(".thread-row").filter({ hasText: "Exam preparation" }).locator(".thread-menu-btn").click();
  await page.getByRole("menuitem", { name: "Delete permanently" }).click();
  await expect(page.locator("#delete-dialog")).toBeVisible();
  await page.locator("#confirm-delete").click();
  await expect(page.locator(".thread-link")).toHaveCount(1);
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".thread-link")).toHaveCount(1);
  await expect(page.locator("#agent-task-title")).toHaveText("Second saved conversation");
  await expect(page.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(0));
  expect(await calls(page, "agent.start")).toHaveLength(0);
});

test("resource attachment resets on project change and removal persists for a sent thread", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "Actions for lecture.txt", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Thread" }).click();
  await expect(page.locator("select#agent-course")).toHaveCount(0);
  await page.locator("#new-project").click();
  await page.locator(".project-option").filter({ hasText: "Legacy algorithms" }).click();
  await expect(page.locator(".resource-chip")).toHaveCount(0);
  await openCourse(page, 14);
  await page.getByRole("button", { name: "Actions for lecture.txt", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Thread" }).click();
  await control(page, "fail", "agent.start", "Fixture retry retains attachment");
  await page.getByLabel("Message Codex").fill("Persist attachment before removal");
  await page.locator("#send-agent").click();
  await expect(page.locator("#agent-messages")).toContainText("Fixture retry retains attachment");
  await page.getByRole("button", { name: "Remove lecture.txt" }).click();
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".resource-chip")).toHaveCount(0);
  await expect(page.getByLabel("Message Codex")).toHaveValue("Persist attachment before removal");
  await expect(page.locator(".thread-link")).toHaveCount(1);
  expect((await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE)).threads[0].resources).toEqual([]);
});

test("disconnect and reconnect isolates threads by portal AND account", async ({ page, boot }) => {
  await boot();
  await openCourse(page, 14);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "Private account 202 conversation");
  await page.getByLabel("Message Codex").fill("Private account 202 draft");
  await page.locator("#agent-task-title").dblclick();
  await page.getByLabel("Thread name").fill("Private legacy thread");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.locator("#account-button").click();
  await page.locator(`.session-row[data-base-url="${LEGACY}"]`).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#account-label")).toHaveText("Course accounts (1)");
  await page.getByLabel("Student ID", { exact: true }).fill("303");
  await page.getByLabel("Password", { exact: true }).fill("fake-password-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#session-summary")).toContainText("Account 303");
  await page.getByRole("button", { name: "Close accounts" }).click();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await expect(page.getByLabel("Message Codex")).toHaveValue("");
  await expect(page.locator("#course-nav .project")).toHaveCount(0);
  await expect(page.locator(".project-new-thread")).toHaveCount(0);
  await page.locator("#new-project").click();
  await expect(page.locator(".project-option")).toHaveCount(15);
  await expect(page.locator(".project-option").filter({ hasText: "LEGACY-CS01" })).toHaveCount(0);
  await page.locator(".project-option").filter({ hasText: "OTHER-ACCOUNT" }).click();
  await expect(page.locator("#course-nav .project")).toHaveCount(1);
  await expect(page.locator("#course-nav .project")).toContainText("OTHER-ACCOUNT");
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".thread-link")).toHaveCount(0);
  await expect(page.locator("#course-nav .project")).toHaveCount(1);
  await page.locator("#account-button").click();
  await page.locator("#legacy-relogin").click();
  await page.getByLabel("Student ID", { exact: true }).fill("202");
  await page.getByLabel("Password", { exact: true }).fill("fake-password-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#session-summary")).toContainText("Account 202");
  await page.getByRole("button", { name: "Close accounts" }).click();
  await page.locator(".thread-link").filter({ hasText: "Private legacy thread" }).click();
  await expect(page.getByLabel("Message Codex")).toHaveValue("Private account 202 draft");
  await expect(page.locator("#course-nav .project")).toHaveCount(1);
  await expect(page.locator("#course-nav")).not.toContainText("OTHER-ACCOUNT");
  await expect(page.getByRole("button", { name: "New thread in LEGACY-CS01", exact: true })).toBeVisible();
  await page.locator("#new-project").click();
  await expect(page.locator(".project-option")).toHaveCount(18);
  await expect(page.locator(".project-option").filter({ hasText: "LEGACY-CS01" })).toHaveCount(0);
  await expect(page.locator(".project-option").filter({ hasText: "OTHER-ACCOUNT" })).toHaveCount(0);
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored.projects.map((project: any) => project.userId)).toEqual([202, 303]);
  expect(stored.threads).toHaveLength(1);
  expect(await page.evaluate((store) => localStorage.getItem(store), STORE)).not.toContain("fake-password-only");
});

test("login form failure, retry, dual session success, password clearing and logout", async ({ page, boot }) => {
  await boot({ authenticated: false });
  await page.getByRole("button", { name: "Connect UIT account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Course accounts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  expect(await calls(page, "session.login")).toHaveLength(0);
  await page.getByLabel("Student ID", { exact: true }).fill("202");
  await page.getByLabel("Password", { exact: true }).fill("invalid-fixture-password");
  await control(page, "fail", "session.login", "Fixture: invalid credentials");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#login-error")).toContainText("Fixture: invalid credentials");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await page.getByLabel("Password", { exact: true }).fill("valid-fixture-password");
  await control(page, "hold", "session.login");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue with UIT SSO" })).toBeDisabled();
  await control(page, "release", "session.login");
  await expect(page.locator("#login-status")).toContainText("Student ID login connected");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Continue with UIT SSO" }).click();
  await expect(page.locator("#session-summary .session-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Re-login with UIT SSO", exact: true })).toBeVisible();
  expect((await calls(page, "session.ssoLogin"))[0].input).toEqual({ baseUrl: CURRENT });
  expect((await calls(page, "session.login"))[1].input).toEqual({ username: "202", password: "valid-fixture-password", baseUrl: LEGACY });
  await page.getByRole("button", { name: "Disconnect all portals" }).click();
  await expect(page.locator("#session-summary .session-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Close accounts" }).click();
  await expect(page.getByRole("button", { name: "Connect UIT account", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fixture-password");
});

test("concurrent threads route events before start resolves and ignore duplicate/stale completions", async ({ page, boot }) => {
  await boot();
  await control(page, "hold", "agent.start");
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("First concurrent question");
  await page.getByLabel("Message Codex").press("Enter");
  await expect(page.locator("#send-agent")).toBeDisabled();
  await page.locator("#new-project").click();
  await page.locator(".project-option").filter({ hasText: "Legacy algorithms" }).click();
  await page.getByLabel("Message Codex").fill("Second concurrent question");
  await page.locator("#send-agent").click();
  const [first, second] = (await calls(page, "agent.start")).map((call) => call.input);
  expect(first).toMatchObject({ courseId: 1, baseUrl: CURRENT, userId: 101 });
  expect(second).toMatchObject({ courseId: 1, baseUrl: LEGACY, userId: 202 });
  for (const [input, text] of [[second, "Second answer"], [first, "First answer"]] as const) {
    const params = { taskId: input.taskId, threadId: `thread-${input.taskId}`, turnId: `turn-${input.taskId}`, itemId: "answer" };
    await emit(page, "item/agentMessage/delta", { ...params, delta: `${text} streamed` });
    await emit(page, "item/completed", { ...params, item: { id: "answer", type: "agentMessage", text } });
    await emit(page, "turn/completed", params);
    await emit(page, "item/agentMessage/delta", { ...params, delta: "STALE DUPLICATE" });
  }
  await expect(page.locator("#agent-messages")).toContainText("Second answer");
  await expect(page.locator("#agent-messages")).not.toContainText("First answer");
  await control(page, "release", "agent.start", 1);
  await control(page, "release", "agent.start", 0);
  await expect(page.locator("#agent-status")).toHaveText("Ready");
  await page.locator(".thread-link").filter({ hasText: "First concurrent question" }).click();
  await expect(page.locator("#agent-messages .assistant")).toHaveCount(1);
  await expect(page.locator("#agent-messages .assistant pre")).toHaveText("First answer");
  await expect(page.locator("#agent-status")).toHaveText("Ready");
  await expect(page.locator("select#agent-course")).toHaveCount(0);
  await emit(page, "item/agentMessage/delta", { taskId: "unknown-task", threadId: `thread-${first.taskId}`, delta: "UNROUTED" });
  await expect(page.locator("#agent-messages")).not.toContainText("UNROUTED");
  await page.getByLabel("Message Codex").fill("Follow up");
  await page.locator("#send-agent").click();
  expect((await calls(page, "agent.send"))[0].input).toMatchObject({ threadId: `thread-${first.taskId}`, baseUrl: CURRENT, userId: 101, message: "Follow up" });
  await page.locator("#stop-agent").click();
  await expect(page.locator("#agent-status")).toHaveText("Ready");
  await expect(page.locator("#agent-messages")).toContainText("This turn was stopped");
  await branchThread(page);
  await expect(page.locator("#agent-task-title")).toHaveText("Branch: First concurrent question");
  await expect(page.locator("#agent-messages")).toContainText("First answer");
});

test("approval belongs to background thread, denial and errors are recoverable", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("Run fixture command");
  await page.locator("#send-agent").click();
  const input = (await calls(page, "agent.start"))[0].input;
  const params = { taskId: input.taskId, threadId: `thread-${input.taskId}`, turnId: `turn-${input.taskId}` };
  await page.locator("#new-project").click();
  await page.locator(".project-option").filter({ has: page.getByText("Computer science 2", { exact: true }) }).click();
  await emit(page, "agent/approval", { ...params, requestId: "approval-1", command: "fixture-command --dry-run" });
  await expect(page.locator(".approval")).toHaveCount(0);
  await page.locator(".thread-link").filter({ hasText: "Run fixture command" }).click();
  await expect(page.locator("#agent-status")).toHaveText("Waiting for approval");
  await control(page, "fail", "agent.approve", "Fixture approval transport error");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator(".approval")).toContainText("Approval failed");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator(".approval")).toHaveCount(0);
  expect((await calls(page, "agent.approve"))[1].input).toEqual({ requestId: "approval-1", approved: false });
  await emit(page, "agent/error", { ...params, message: "Fixture disconnected", willRetry: false });
  await expect(page.locator("#agent-status")).toContainText("Connection interrupted");
  await expect(page.locator("#agent-messages")).toContainText("Fixture disconnected");
});

test("composer groups YOLO, Fast, and model controls, with UIT approvals available", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await expect(page.locator(".composer-options")).toBeVisible();
  await expect(page.locator(".composer-submit")).toBeVisible();
  const yolo = page.locator("#yolo-toggle");
  await expect(yolo).toHaveAttribute("aria-pressed", "true");
  await expect(yolo).toContainText("YOLO");
  await expect(yolo).not.toContainText("⚡");

  await yolo.click();
  await expect(yolo).toHaveAttribute("aria-pressed", "false");
  await expect(yolo).toContainText("Approvals");
  await expect(yolo).not.toContainText("🛡");
  const fast = page.locator("#fast-toggle");
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  await expect(fast).toContainText("Fast");
  await page.getByLabel("Message Codex").fill("Read the course contents");
  await page.locator("#send-agent").click();
  const input = (await calls(page, "agent.start")).at(-1)!.input;
  expect(input).toMatchObject({ yolo: false, fast: true });
  const params = { threadId: `thread-${input.taskId}`, taskId: input.taskId, turnId: `turn-${input.taskId}` };
  await emit(page, "agent/approval", {
    ...params, requestId: "mcp-approval", kind: "mcp", serverName: "uit", toolName: "uit_course_contents",
    description: "Read course modules, sections, assignments, and announcements for a UIT course.",
    argumentsText: "Arguments: {\"courseId\":592}", command: "uit · uit_course_contents"
  });
  await expect(page.locator(".approval")).toContainText("Allow this UIT tool?");
  await expect(page.locator(".approval")).toContainText("uit · uit_course_contents");
  await expect(page.locator(".approval")).toContainText("Read course modules");
  await expect(page.locator(".approval")).toContainText("Arguments: {\"courseId\":592}");
  await expect(page.locator(".approval")).not.toContainText("Allow the uit MCP server");
  await expect(page.locator(".approval")).not.toContainText("Future UIT tool requests");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Always allow", exact: true }).click();
  await expect(page.locator(".approval")).toHaveCount(0);
  expect((await calls(page, "agent.approve")).at(-1)!.input).toEqual({ requestId: "mcp-approval", approved: true, remember: "uit-session" });
  await emit(page, "turn/completed", { ...params, turn: { id: params.turnId, status: "completed" } });
  await expect(page.locator("#agent-status")).toHaveText("Ready");
});

test("failed first send persists prompted thread, restores draft and resource for retry after reload", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "Actions for Assignment 7", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Thread" }).click();
  await control(page, "fail", "agent.start", "Fixture agent unavailable");
  await page.getByLabel("Message Codex").fill("Help with assignment");
  await page.locator("#send-agent").click();
  await expect(page.locator("#agent-messages")).toContainText("Fixture agent unavailable");
  await expect(page.getByLabel("Message Codex")).toHaveValue("Help with assignment");
  await expect(page.locator("#resource-chips")).toContainText("@Assignment 7");
  await expect(page.locator(".thread-link")).toHaveCount(1);
  const stored = await page.evaluate((store) => JSON.parse(localStorage.getItem(store)!), STORE);
  expect(stored.threads).toHaveLength(1);
  expect(stored.threads[0]).toMatchObject({ prompted: true, draft: "Help with assignment", course: { id: 1, baseUrl: CURRENT, userId: 101 } });
  expect(stored.activeId).toBe(stored.threads[0].id);
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator(".thread-link")).toHaveCount(1);
  await expect(page.getByLabel("Message Codex")).toHaveValue("Help with assignment");
  await expect(page.locator("#resource-chips")).toContainText("@Assignment 7");
  expect(await calls(page, "agent.start")).toHaveLength(0);
  await page.locator("#send-agent").click();
  await expect(page.locator("#agent-status")).toHaveText("Codex is working...");
  expect((await calls(page, "agent.start"))[0].input.resources).toEqual([{ kind: "assignment", id: 607, moduleId: 707 }]);
});

test("stale course detail responses cannot replace a later course or navigation", async ({ page, boot }) => {
  await boot();
  for (const method of ["courses.contents", "courses.assignments", "courses.announcements"]) await control(page, "hold", method);
  await page.locator(".course-row").first().click();
  await expect(page.locator("#course-detail h1")).toHaveText(courses[0].fullname);
  await page.getByRole("button", { name: "All courses", exact: false }).click();
  await page.locator(".course-row").filter({ hasText: "Legacy algorithms" }).click();
  await expect(page.locator("#course-detail h1")).toHaveText("Legacy algorithms");
  for (const method of ["courses.contents", "courses.assignments", "courses.announcements"]) await control(page, "release", method, 1);
  await expect(page.locator("#contents-panel .file-row")).toHaveCount(fileTypes.length);
  for (const method of ["courses.contents", "courses.assignments", "courses.announcements"]) await control(page, "release", method, 0);
  await expect(page.locator("#contents-panel .file-row").first()).toHaveAttribute("data-file-url", new RegExp(`^${LEGACY}`));
  await page.getByRole("button", { name: "Refresh resources" }).click();
  await page.locator('.nav-item[data-view="agent"]').click();
  for (const method of ["courses.contents", "courses.assignments", "courses.announcements"]) await control(page, "release", method);
  await expect(page.locator("#view-agent")).toBeVisible();
  await expect(page.locator("#view-course")).toBeHidden();
});

test("closed stale file preview cannot overwrite a newer resource reader", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await control(page, "hold", "courses.preview");
  await page.locator("#contents-panel .resource-open").filter({ hasText: "script.py" }).click();
  await expect(page.locator("#reader-body")).toContainText("Loading preview");
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(page.locator("#reader-body")).toBeEmpty();
  await page.locator("#announcement-list .resource-open").last().click();
  await control(page, "release", "courses.preview");
  await expect(page.locator("#reader-title")).toHaveText("Announcement 6");
  await expect(page.locator("#reader-body")).toContainText("Full announcement 6");
  await expect(page.locator("#reader-body")).not.toContainText("hello from memory");
});

test("stale list response cannot repopulate courses after logout", async ({ page, boot }) => {
  await boot();
  await control(page, "hold", "courses.refresh");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator("#account-button").click();
  await page.getByRole("button", { name: "Disconnect all portals" }).click();
  await expect(page.locator("#account-label")).toHaveText("Connect accounts");
  await control(page, "release", "courses.refresh");
  await page.getByRole("button", { name: "Close accounts" }).click();
  await expect(page.locator(".course-row")).toHaveCount(0);
  await expect(page.locator("#course-nav .project")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect UIT account", exact: true })).toBeVisible();
});

test("list, detail, preview, download and open failures offer recovery", async ({ page, boot }) => {
  await boot({ fail: { "courses.list": "Fixture list offline" } });
  await expect(page.locator("#course-grid [role=alert]")).toContainText("Fixture list offline");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".course-row")).toHaveCount(19);
  await control(page, "fail", "courses.assignments", "Fixture assignment offline");
  await openCourse(page);
  await expect(page.locator("#assignment-list [role=alert]")).toContainText("Fixture assignment offline");
  await page.locator("#assignment-list").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("#assignment-list .resource-row")).toHaveCount(7);
  await control(page, "fail", "courses.preview", "Fixture preview offline");
  await page.locator("#contents-panel .resource-open").filter({ hasText: "script.py" }).click();
  await expect(page.locator("#reader-body [role=alert]")).toContainText("Fixture preview offline");
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect(page.locator("#reader-body pre")).toHaveText("print('hello from memory')");
  await control(page, "fail", "courses.materialize", "Fixture disk full");
  await page.locator("#reader-download").click();
  await expect(page.locator("#reader-status")).toContainText("Download failed. Fixture disk full");
  await expect(page.locator("#reader-download")).toBeEnabled();
  await page.locator("#reader-download").click();
  await expect(page.locator("#reader-status")).toContainText("Saved to");
  await control(page, "fail", "courses.open", "Fixture portal disconnected");
  await page.locator("#reader-moodle").click();
  await expect(page.locator("#reader-status")).toContainText("Reconnect this portal");
});

test("malformed saved index is reported without crashing the renderer", async ({ page, boot }) => {
  await boot({ storage: "{invalid-json" });
  await expect(page.locator("#app-error")).toContainText("Saved threads could not be read");
  expect(await page.evaluate((store) => localStorage.getItem(store), STORE)).toBe("{invalid-json");
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await expect(page.getByLabel("Message Codex")).toBeEnabled();
});

test("storage quota failure is visible and a later draft save recovers", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "Saved before storage fills");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "uit-studio.threads.v1" && window.__mock.storageFull) throw new DOMException("Fixture storage full", "QuotaExceededError");
      original.call(this, key, value);
    };
    window.__mock.storageFull = true;
  });
  await page.getByLabel("Message Codex").fill("Keep this draft in memory");
  await expect(page.locator("#app-error")).toContainText("Thread changes could not be saved");
  await page.evaluate(() => { window.__mock.storageFull = false; });
  await page.getByLabel("Message Codex").fill("Recovered draft");
  await expect(page.locator("#app-error")).toBeHidden();
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.getByLabel("Message Codex")).toHaveValue("Recovered draft");
});

test("SSO cancellation can retry and graduate legacy form sends the selected portal", async ({ page, boot }) => {
  await boot({ authenticated: false });
  await page.getByRole("button", { name: "Connect UIT account", exact: true }).click();
  await control(page, "fail", "session.ssoLogin", "Fixture SSO window was closed");
  await page.getByRole("button", { name: "Continue with UIT SSO" }).click();
  await expect(page.locator("#login-error")).toContainText("Fixture SSO window was closed");
  await page.getByRole("button", { name: "Continue with UIT SSO" }).click();
  await expect(page.locator("#session-summary")).toContainText("Account 101");
  await page.getByRole("combobox", { name: "Portal", exact: true }).selectOption(`${LEGACY}/sdh`);
  await page.getByLabel("Student ID", { exact: true }).fill("404");
  await page.getByLabel("Password", { exact: true }).fill("graduate-fixture-password");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#session-summary .session-row")).toHaveCount(2);
  expect((await calls(page, "session.login"))[0].input).toEqual({ baseUrl: `${LEGACY}/sdh`, username: "404", password: "graduate-fixture-password" });
  await page.getByRole("button", { name: "Close accounts" }).click();
  await page.locator("#account-button").click();
  await expect(page.getByLabel("Student ID", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});

test("completed conversation persists, stream output deduplicates and offline reload never sends", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("Explain the course");
  await page.locator("#send-agent").click();
  const input = (await calls(page, "agent.start"))[0].input;
  const params = { taskId: input.taskId, threadId: `thread-${input.taskId}`, turnId: `turn-${input.taskId}` };
  await emit(page, "item/started", { ...params, item: { id: "cmd", type: "commandExecution", command: "fixture-command" } });
  await emit(page, "item/commandExecution/outputDelta", { ...params, itemId: "cmd", delta: "safe output" });
  await emit(page, "item/completed", { ...params, item: { id: "cmd", type: "commandExecution", command: "fixture-command", aggregatedOutput: "safe output", exitCode: 0 } });
  await emit(page, "item/completed", { ...params, item: { id: "files", type: "fileChange", changes: [{ kind: "update", path: "notes.md" }] } });
  await emit(page, "item/agentMessage/delta", { ...params, itemId: "answer", delta: "Partial answer" });
  await emit(page, "item/completed", { ...params, item: { id: "answer", type: "agentMessage", text: "Final explanation" } });
  await emit(page, "turn/completed", { ...params, turn: { id: params.turnId, status: "completed" } });
  await expect(page.locator("#agent-messages .assistant")).toHaveCount(1);
  await expect(page.locator("#agent-messages .assistant pre")).toHaveText("Final explanation");
  await expect(page.locator("#agent-messages .assistant .agent-avatar")).toHaveCount(0);
  await expect(page.locator("#agent-messages")).toContainText("Ran fixture-command · exit 0");
  await expect(page.locator("#agent-messages")).toContainText("update: notes.md");
  await page.getByLabel("Message Codex").fill("Unsent follow-up");
  await page.reload();
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#agent-messages .assistant pre")).toHaveText("Final explanation");
  await expect(page.getByLabel("Message Codex")).toHaveValue("Unsent follow-up");
  await expect(page.locator("#agent-workspace")).toContainText("/fixture/UIT/CS01");
  await expect(page.locator("select#agent-course")).toHaveCount(0);
  for (const method of ["agent.start", "agent.send", "workspace.create"]) expect(await calls(page, method)).toHaveLength(0);
});

test("rollout sync repairs matching items and keeps distinct messages with overlapping text", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("Start externally");
  await page.locator("#send-agent").click();
  const input = (await calls(page, "agent.start"))[0].input;
  const params = { taskId: input.taskId, threadId: `thread-${input.taskId}`, turnId: `turn-${input.taskId}` };
  await emit(page, "item/completed", { ...params, item: { id: "answer", type: "agentMessage", text: "OK" } });
  await emit(page, "turn/completed", { ...params, turn: { id: params.turnId, status: "completed" } });

  await page.evaluate(() => {
    window.uit.agent.readRollout = async () => ({
      mtime: Date.now(),
      messages: [
        { id: "prompt", turnId: "external-turn", role: "user", text: "Start externally\n\nCourse: Computer science 1\nPortal: https://courses.uit.edu.vn" },
        { id: "answer", turnId: "external-turn", role: "assistant", text: "Complete answer" },
        { id: "another-answer", turnId: "external-turn", role: "assistant", text: "OK, completed" }
      ]
    });
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator("#agent-messages .user")).toHaveCount(1);
  await expect(page.locator("#agent-messages .user")).toContainText("Start externally");
  await expect(page.locator("#agent-messages .assistant")).toHaveCount(2);
  await expect(page.locator("#agent-messages .assistant").nth(0)).toContainText("Complete answer");
  await expect(page.locator("#agent-messages .assistant").nth(1)).toContainText("OK, completed");
});

test("global agent exit interrupts busy threads without losing their independent drafts", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("Working thread one");
  await page.locator("#send-agent").click();
  await page.getByLabel("Message Codex").fill("Next draft one");
  await page.locator("#new-project").click();
  await page.locator(".project-option").filter({ has: page.getByText("Computer science 2", { exact: true }) }).click();
  await page.getByLabel("Message Codex").fill("Working thread two");
  await page.locator("#send-agent").click();
  await page.getByLabel("Message Codex").fill("Next draft two");
  await emit(page, "codex/exit", { code: 1 });
  for (const [title, draft] of [["Working thread one", "Next draft one"], ["Working thread two", "Next draft two"]]) {
    await page.locator(".thread-link").filter({ hasText: title }).click();
    await expect(page.locator("#agent-status")).toContainText("Connection interrupted");
    await expect(page.getByLabel("Message Codex")).toHaveValue(draft);
    await expect(page.locator("#agent-messages")).toContainText("Codex disconnected");
    await expect(page.locator("#send-agent")).toBeEnabled();
  }
});

test("keyboard navigation, dialog focus, skip link and composer newline", async ({ page, boot }) => {
  await boot();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await page.getByRole("searchbox").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Semester", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".course-row").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#course-detail h1")).toHaveText(courses[0].fullname);
  const overflow = page.getByRole("button", { name: "Actions for lecture.txt", exact: true });
  await overflow.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "New Thread" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(overflow).toBeFocused();
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Message Codex").fill("First line");
  await page.getByLabel("Message Codex").press("Shift+Enter");
  await page.getByLabel("Message Codex").pressSequentially("Second line");
  await expect(page.getByLabel("Message Codex")).toHaveValue("First line\nSecond line");
  expect(await calls(page, "agent.start")).toHaveLength(0);
});

test("select chevrons reserve text padding across course, appearance, project and portal fields", async ({ page, boot }) => {
  await boot();
  for (const selector of ["#semester-select", "#appearance", "#course-site"]) {
    await expect(page.locator(selector)).toHaveCSS("padding-right", "34px");
    await expect(page.locator(selector)).toHaveCSS("background-image", /chevron\.svg/);
    await expect(page.locator(selector)).toHaveCSS("background-position", "calc(100% - 12px) 50%");
  }
});

for (const width of [390, 320]) {
  test(`mobile ${width}px has no horizontal overflow and navigation focus is trapped`, async ({ page, boot }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await boot();
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await noOverflow();
    await page.screenshot({ path: info.outputPath(`mobile-${width}-courses.png`), fullPage: true });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("#close-sidebar")).toBeFocused();
    expect(await page.locator("#main").evaluate((element: HTMLElement) => element.inert)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#account-button")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#close-sidebar")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    expect(await page.locator("#sidebar").evaluate((element: HTMLElement) => element.inert)).toBe(true);
    await page.locator(".course-row").first().click();
    await expect(page.locator("#contents-panel .file-row")).toHaveCount(fileTypes.length);
    await noOverflow();
    await page.getByRole("button", { name: "Actions for Announcement 6", exact: true }).click();
    await noOverflow();
    await page.getByRole("menuitem", { name: "New Thread" }).click();
    await page.getByLabel("Message Codex").fill("Mobile unsent draft " + "longword".repeat(30));
    await noOverflow();
    await expect(page.locator("#send-agent")).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`mobile-${width}-agent.png`), fullPage: true });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator("#account-button").click();
    await expect(page.getByRole("dialog", { name: "Course accounts", exact: true })).toBeVisible();
    await noOverflow();
    await page.locator("#legacy-relogin").click();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });
}

test.use({ colorScheme: "light", headless: true });

for (const [stored, os, theme] of [
  [null, "light", "light"], [null, "dark", "dark"],
  ["system", "dark", "dark"],
  ["light", "dark", "light"], ["dark", "light", "dark"],
  ["unknown-theme", "light", "light"], ["unknown-theme", "dark", "dark"],
] as const) {
  test(`appearance prepaint: stored ${stored}, OS ${os} resolves to ${theme}`, async ({ page, boot }) => {
    await page.emulateMedia({ colorScheme: os });
    await page.addInitScript((stored) => {
      if (stored !== null) localStorage.setItem("uit-studio.appearance", stored);
      const observer = new MutationObserver(() => {
        const theme = document.documentElement?.dataset.theme;
        if (!theme) return;
        sessionStorage.setItem("test.appearance-prepaint", JSON.stringify({
          theme, hasBody: !!document.body,
          hasStylesheet: !!document.querySelector('link[rel="stylesheet"]'),
          readyState: document.readyState,
        }));
        observer.disconnect();
      });
      observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme"] });
    }, stored);
    await boot();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("test.appearance-prepaint")!))).toEqual({
      theme, hasBody: false, hasStylesheet: false, readyState: "loading",
    });
    const preference = stored === "light" || stored === "dark" ? stored : "system";
    await expect(page.locator("#sidebar").getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue(preference);
    await expect(page.locator("#appearance option")).toHaveText(["System", "Light", "Dark"]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    for (const colorScheme of [os === "dark" ? "light" : "dark", os] as const) {
      await page.emulateMedia({ colorScheme });
      const resolved = preference === "system" ? colorScheme : preference;
      await expect(page.locator("html")).toHaveAttribute("data-theme", resolved);
      await expect(page.locator("html")).toHaveCSS("color-scheme", resolved);
      await expect(page.locator("#appearance")).toHaveValue(preference);
    }
    expect(await page.evaluate(() => localStorage.getItem("uit-studio.appearance"))).toBe(stored);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`explicit ${theme} appearance persists across reload and OS changes until System is selected`, async ({ page, boot }) => {
    const opposite = theme === "dark" ? "light" : "dark";
    await page.emulateMedia({ colorScheme: opposite });
    await boot();
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => localStorage.getItem("uit-studio.appearance"))).toBe(theme);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const colorScheme of [theme, opposite]) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    }
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", opposite);
    expect(await page.evaluate(() => localStorage.getItem("uit-studio.appearance"))).toBe("system");
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", opposite);
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  });

  test(`${theme} core appearance tokens meet WCAG AA normal-text contrast`, async ({ page, boot }) => {
    await boot();
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const ratios = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const luminance = (token: string) => {
        const color = style.getPropertyValue(token).trim();
        if (!color || !CSS.supports("color", color)) throw new Error(`Invalid color token ${token}: ${color}`);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const pairs = [
        ["--text", "--background"], ["--muted", "--background"],
        ["--text", "--surface"], ["--muted", "--surface"],
        ["--on-primary", "--primary"], ["--on-primary", "--primary-hover"],
        ["--error", "--background"], ["--error", "--surface"], ["--error", "--error-background"],
      ];
      return pairs.map(([foreground, background]) => {
        const a = luminance(foreground), b = luminance(background);
        return { pair: `${foreground} on ${background}`, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    for (const { pair, ratio } of ratios) expect.soft(ratio, `${theme}: ${pair}`).toBeGreaterThanOrEqual(4.5);
  });
}

test("appearance storage write failure reports unsaved preference while applying it and can recover", async ({ page, boot }) => {
  await boot();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.__mock.appearanceStorageFull = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === "uit-studio.appearance" && window.__mock.appearanceStorageFull) throw new DOMException("Fixture storage full", "QuotaExceededError");
      setItem.call(this, key, value);
    };
  });
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("#appearance")).toHaveValue("dark");
  await expect(page.locator("#appearance-status")).toHaveAttribute("role", "status");
  await expect(page.locator("#appearance-status")).toBeVisible();
  await expect(page.locator("#appearance-status")).toHaveText("Appearance changed for this window, but could not be saved.");
  expect(await page.evaluate(() => localStorage.getItem("uit-studio.appearance"))).toBe("light");
  await openCourse(page);
  await expect(page.locator("#course-detail h1")).toBeVisible();
  await page.evaluate(() => { window.__mock.appearanceStorageFull = false; });
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("system");
  await expect(page.locator("#appearance-status")).toBeHidden();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  await page.reload();
  await expect(page.locator("#appearance")).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("uit-studio.appearance"))).toBe("dark");
});

test("appearance synchronizes real cross-tab storage changes, ignores other keys and falls back on removal", async ({ page, boot, context }) => {
  await boot();
  // A same-origin blank document writes storage without starting another renderer.
  const other = await context.newPage();
  try {
    await other.route("**/appearance-peer", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Appearance peer</title>" }));
    await other.goto(new URL("/appearance-peer", page.url()).href);
    for (const preference of ["dark", "light", "system", "invalid", null]) {
      await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(preference === "light" ? "dark" : "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await other.evaluate((value) => {
        if (value === null) localStorage.removeItem("uit-studio.appearance");
        else localStorage.setItem("uit-studio.appearance", value);
      }, preference);
      const selected = preference === "light" || preference === "dark" ? preference : "system";
      await expect(page.locator("#appearance")).toHaveValue(selected);
      await expect(page.locator("html")).toHaveAttribute("data-theme", selected === "light" ? "light" : "dark");
    }
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
    await other.evaluate(() => localStorage.setItem("test.unrelated", "dark"));
    await expect(page.locator("#appearance")).toHaveValue("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await other.evaluate(() => localStorage.clear());
    await expect(page.locator("#appearance")).toHaveValue("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally { await other.close(); }
});

test("dark course resources, reader, action dialog, agent chip and composer use dark surfaces", async ({ page, boot }, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await boot();
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(15, 17, 23)");
  await expect(page.locator("#sidebar")).toHaveCSS("background-color", "rgb(12, 14, 19)");
  await expect(page.locator(".course-row").first()).toHaveCSS("color", "rgb(235, 238, 243)");
  await expect(page.locator(".course-code").first()).toHaveCSS("color", "rgb(166, 173, 189)");
  await openCourse(page);
  await expect(page.locator("#contents-panel .resource-info strong").first()).toHaveCSS("color", "rgb(235, 238, 243)");
  await expect(page.locator("#contents-panel .section-label").first()).toHaveCSS("color", "rgb(166, 173, 189)");
  await expect(page.locator("#assignment-list .resource-row")).toHaveCount(7);
  await expect(page.locator("#announcement-list .resource-row")).toHaveCount(6);
  await page.screenshot({ path: info.outputPath("dark-course.png"), fullPage: true });
  await page.locator("#contents-panel .resource-open").filter({ hasText: "script.py" }).click();
  await expect(page.locator("#reader-body pre")).toHaveText("print('hello from memory')");
  await expect(page.locator("#resource-reader")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(page.locator("#reader-body pre")).toHaveCSS("background-color", "rgb(14, 16, 22)");
  await expect(page.locator("#reader-body pre")).toHaveCSS("color", "rgb(235, 238, 243)");
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.getByRole("button", { name: "Actions for lecture.txt", exact: true }).click();
  await expect(page.locator("#resource-menu")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await page.getByRole("menuitem", { name: "New Thread" }).click();
  await expect(page.locator(".resource-chip")).toContainText("@lecture.txt");
  await expect(page.locator(".resource-chip")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(page.locator(".resource-chip")).toHaveCSS("color", "rgb(235, 238, 243)");
  await expect(page.locator("#agent-form")).toHaveCSS("background-color", "rgb(23, 27, 38)");
  await expect(page.getByLabel("Message Codex")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByLabel("Message Codex")).toHaveCSS("color", "rgb(235, 238, 243)");
  await page.getByLabel("Message Codex").fill("Explain the attached lecture and help me prepare for the exam.");
  await expect(page.locator("#send-agent")).toBeEnabled();
  await expect(page.locator("#send-agent")).toHaveCSS("background-color", "rgb(59, 130, 246)");
  await expect(page.locator("#send-agent")).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.screenshot({ path: info.outputPath("dark-agent.png"), fullPage: true });
  for (const method of ["agent.start", "courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
  await sendAndStop(page, "Open a saved thread action dialog");
  await page.locator("#agent-task-title").dblclick();
  await expect(page.locator("#rename-dialog")).toBeVisible();
  await expect(page.locator("#rename-dialog")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  for (const method of ["courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

test("dark PDF toolbar and dialog leave the white document canvas and rendered pixels unchanged", async ({ page, boot }, info) => {
  await boot();
  await openCourse(page);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
  const canvas = page.locator('.pdf-page[data-page="1"] .pdf-canvas');
  const lightPixels = await canvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  // OS changes can reach a modal without bypassing its native focus/inert behavior.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#resource-reader")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(page.locator(".pdf-toolbar")).toHaveCSS("color", "rgb(235, 238, 243)");
  await expect(page.locator(".pdf-toolbar")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(page.locator(".pdf-surface")).toHaveCSS("background-color", "rgb(12, 14, 19)");
  await expect(canvas).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(canvas).toHaveCSS("filter", "none");
  expect(await canvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(lightPixels);
  const pixels = await canvas.evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let white = 0, ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255) continue;
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
      if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) ink++;
    }
    return { white, ink };
  });
  expect(pixels.white).toBeGreaterThan(1000);
  expect(pixels.ink).toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath("dark-pdf.png"), fullPage: true });
  await page.getByRole("spinbutton", { name: "Page number" }).fill("2");
  await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
  await expect(page.locator(".pdf-status")).toContainText("Page 2 of 2 rendered");
  await expect(page.locator('.pdf-page[data-page="2"] canvas')).toHaveCSS("background-color", "rgb(255, 255, 255)");
  for (const method of ["courses.materialize", "courses.open", "shell.open"]) expect(await calls(page, method)).toHaveLength(0);
});

test("dark login dialog, native fields and visible credential error remain readable", async ({ page, boot }, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await boot({ authenticated: false });
  await page.getByRole("button", { name: "Connect UIT account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Course accounts", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(dialog).toHaveCSS("color", "rgb(235, 238, 243)");
  await expect(dialog).toHaveCSS("color-scheme", "dark");
  for (const field of [dialog.getByRole("combobox", { name: "Portal", exact: true }), dialog.getByLabel("Student ID", { exact: true }), dialog.getByLabel("Password", { exact: true })]) {
    await expect(field).toHaveCSS("background-color", "rgb(21, 25, 35)");
    await expect(field).toHaveCSS("color", "rgb(235, 238, 243)");
  }
  await page.getByLabel("Student ID", { exact: true }).fill("202");
  await page.getByLabel("Password", { exact: true }).fill("fixture-only-password");
  await control(page, "fail", "session.login", "Fixture: invalid credentials");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#login-error")).toContainText("Fixture: invalid credentials");
  await expect(page.locator("#login-error")).toHaveCSS("color", "rgb(255, 170, 160)");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.screenshot({ path: info.outputPath("dark-login.png"), fullPage: true });
  await page.getByRole("button", { name: "Close accounts" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

for (const width of [390, 320]) {
  test(`dark mobile ${width}px appearance select participates in navigation focus trap`, async ({ page, boot }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await boot();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("#close-sidebar")).toBeFocused();
    expect(await page.locator("#main").evaluate((element: HTMLElement) => element.inert)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#account-button")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toBeFocused();
    await expect(page.locator("#appearance")).toBeInViewport();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#course-nav button").last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#appearance")).toBeFocused();
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: info.outputPath(`dark-mobile-${width}-appearance.png`), fullPage: true });
    await page.keyboard.press("Tab");
    await expect(page.locator("#account-button")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#close-sidebar")).toBeFocused();
    await page.locator("#course-nav").getByRole("button", { name: courses[0].shortname, exact: true }).click();
    await expect(page.locator("#contents-panel .file-row")).toHaveCount(fileTypes.length);
    await expect(page.locator("#sidebar")).toBeHidden();
    expect(await page.locator("#main").evaluate((element: HTMLElement) => element.inert)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`dark-mobile-${width}-course.png`), fullPage: true });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator("#appearance").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    expect(await page.locator("#sidebar").evaluate((element: HTMLElement) => element.inert)).toBe(true);
    await page.getByRole("button", { name: "Actions for lecture.txt", exact: true }).click();
    await page.getByRole("menuitem", { name: "New Thread" }).click();
    await page.getByLabel("Message Codex").fill("Dark mobile draft " + "longword".repeat(30));
    await expect(page.locator(".resource-chip")).toContainText("@lecture.txt");
    await expect(page.locator("#send-agent")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`dark-mobile-${width}-agent.png`), fullPage: true });
  });
}

test("course view displays Materials, Members, and Grades tabs with live data and search", async ({ page, boot }) => {
  await boot();
  await openCourse(page);

  await expect(page.locator("#tab-materials")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tab-members")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#tab-grades")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#panel-materials")).toBeVisible();
  await expect(page.locator("#panel-members")).toBeHidden();
  await expect(page.locator("#panel-grades")).toBeHidden();

  await page.locator("#tab-members").click();
  await expect(page.locator("#tab-members")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-members")).toBeVisible();
  await expect(page.locator("#panel-materials")).toBeHidden();
  await expect(page.locator(".members-count")).toHaveText("2 members");
  await expect(page.locator(".member-card")).toHaveCount(2);
  await expect(page.locator(".member-card img")).toHaveCount(0);
  await expect(page.locator(".member-card .member-avatar")).toHaveCount(2);
  await expect(page.locator(".member-card .member-avatar").first()).toHaveClass(/teacher-avatar/);
  await expect(page.locator(".member-card").first()).toContainText("Dr. Bob");
  await expect(page.locator(".member-card").first()).toContainText("GVLT");
  await expect(page.locator(".member-card").first().locator(".role-badge.role-teacher")).toHaveCount(1);
  await expect(page.locator(".member-card").last()).toContainText("Alice Student");
  await expect(page.locator(".member-card").last().locator(".role-badge")).toHaveCount(0);

  await page.getByPlaceholder("Search members by name or role...").fill("Bob");
  await expect(page.locator(".member-card")).toHaveCount(1);
  await expect(page.locator(".member-card")).toContainText("Dr. Bob");
  await page.getByPlaceholder("Search members by name or role...").fill("GVLT");
  await expect(page.locator(".member-card")).toHaveCount(1);
  await expect(page.locator(".member-card")).toContainText("Dr. Bob");
  await page.getByPlaceholder("Search members by name or role...").fill("");
  await expect(page.locator(".member-card")).toHaveCount(2);

  await page.locator("#tab-grades").click();
  await expect(page.locator("#tab-grades")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-grades")).toBeVisible();
  await expect(page.locator("#panel-members")).toBeHidden();
  await expect(page.locator(".grades-total-card")).toContainText("Course total");
  await expect(page.locator(".grades-total-score")).toContainText("9.5");
  await expect(page.locator(".grades-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".grades-table")).toContainText("Lab 1");

  await page.locator("#tab-materials").click();
  await expect(page.locator("#panel-materials")).toBeVisible();
  await expect(page.locator("#contents-panel")).toBeVisible();
});

test("thread header displays Open in dropdown with Codex CLI and Desktop App options", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "Test Open in actions");

  // Verify the Open in button and menu exist in the header
  const resumeBtn = page.locator("#thread-resume-btn");
  await expect(resumeBtn).toBeVisible();
  await expect(resumeBtn).toHaveText("Open in");
  await expect(resumeBtn).not.toContainText("Open in...");

  const resumeMenu = page.locator("#thread-resume-menu");
  await expect(resumeMenu).toBeHidden();

  // Toggle menu open
  await resumeBtn.click();
  await expect(resumeMenu).toBeVisible();
  await expect(page.locator("#resume-codex-cli")).toContainText("Codex CLI");
  await expect(page.locator("#resume-codex-app")).toContainText("ChatGPT Desktop App");

  // Clicking Codex CLI reveals command row without automatically closing or copying
  const cliRow = page.locator("#cli-command-row");
  await expect(cliRow).toBeHidden();
  await page.locator("#resume-codex-cli").click();
  await expect(cliRow).toBeVisible();
  await expect(page.locator("#cli-cmd-text")).toContainText("codex resume");

  // Clicking copy button copies and triggers checkmark
  await page.locator("#copy-cli-cmd-btn").click();
  await expect(page.locator("#copy-cli-cmd-btn .check-icon")).toBeVisible();

  // Press Escape to close
  await page.keyboard.press("Escape");
  await expect(resumeMenu).toBeHidden();
});

test("during thread-lock, input box, rename, and delete options convert to not-allowed cursor and are disabled", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await sendAndStop(page, "Test Locked State");

  // Mock thread being locked externally
  await page.evaluate(async () => {
    window.uit.agent.lockStatus = async () => ({ locked: true });
    window.dispatchEvent(new Event("focus"));
  });

  // Input box is disabled and has cursor: not-allowed
  const input = page.locator("#agent-input");
  await expect(input).toBeDisabled();
  await expect(input).toHaveCSS("cursor", "not-allowed");

  // Thread actions rail menu has Rename and Delete disabled with cursor: not-allowed
  await page.locator(".thread-row .thread-menu-btn").first().click();
  const renameBtn = page.locator(".rail-menu button", { hasText: "Rename" });
  const deleteBtn = page.locator(".rail-menu button", { hasText: "Delete permanently" });

  await expect(renameBtn).toBeDisabled();
  await expect(renameBtn).toHaveCSS("cursor", "not-allowed");

  await expect(deleteBtn).toBeDisabled();
  await expect(deleteBtn).toHaveCSS("cursor", "not-allowed");
});

test("copy buttons for user and agent messages are positioned smartly and copy text with feedback", async ({ page, boot }, info) => {
  await boot({
    storage: JSON.stringify({
      version: 1,
      activeId: "copy-test",
      threads: [{
        id: "copy-test",
        title: "Copy Button Test",
        course: courses[0],
        draft: "",
        resources: [],
        messages: [
          { role: "user", text: "Explain binary search in detail" },
          { role: "assistant", text: "Binary search is an efficient algorithm with O(log n) time complexity." },
        ],
        prompted: true,
        renamed: true,
      }],
    }),
  });

  await page.locator('.nav-item[data-view="agent"]').click();
  await page.locator(".thread-link").filter({ hasText: "Copy Button Test" }).click();

  const userMsg = page.locator(".message.user");
  const assistantMsg = page.locator(".message.assistant");

  await expect(userMsg).toBeVisible();
  await expect(assistantMsg).toBeVisible();

  // User message copy button is positioned smartly in .message-actions at the bottom right
  const userCopyBtn = userMsg.locator(".message-actions .message-copy-btn");
  await expect(userCopyBtn).toHaveCount(1);
  await expect(userCopyBtn).toHaveAttribute("title", "Copy message");

  // Timestamps exist on both user and assistant messages in .message-actions
  const userTime = userMsg.locator(".message-actions .message-time");
  const assistantTime = assistantMsg.locator(".message-actions .message-time");
  await expect(userTime).toHaveCount(1);
  await expect(assistantTime).toHaveCount(1);

  // Before hover: timestamp is hidden (opacity: 0)
  const initialUserTimeOpacity = await userTime.evaluate((el) => window.getComputedStyle(el).opacity);
  expect(Number(initialUserTimeOpacity)).toBe(0);

  // Agent message copy button is positioned smartly in .message-actions at the bottom
  const assistantCopyBtn = assistantMsg.locator(".message-actions .message-copy-btn");
  await expect(assistantCopyBtn).toHaveCount(1);
  await expect(assistantCopyBtn).toHaveAttribute("title", "Copy message");

  // Initial screenshot before clicks
  await page.screenshot({ path: info.outputPath("copy_buttons_initial.png") });

  // Hover user message to test visibility
  await userMsg.hover();
  await expect(userTime).toHaveCSS("opacity", "1");
  await expect(userTime).toHaveCSS("visibility", "visible");

  // Verify timestamp font size is smaller than message font size (e.g. 11px < 13px)
  const timeFontSize = await userTime.evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
  const msgFontSize = await userMsg.locator("pre").evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
  expect(timeFontSize).toBeLessThan(msgFontSize);

  await page.screenshot({ path: info.outputPath("copy_buttons_user_hover.png") });

  // Click user copy button
  await userCopyBtn.click();
  await expect(userCopyBtn).toHaveClass(/is-copied/);
  await expect(userCopyBtn).toHaveAttribute("title", "Copied!");
  const userCopyCalls = (await calls(page, "agent.writeClipboard")).filter((c: any) => (c.input?.text || c.input) === "Explain binary search in detail");
  expect(userCopyCalls.length).toBeGreaterThanOrEqual(1);

  // Hover assistant message to test visibility
  await assistantMsg.hover();
  await expect(assistantTime).toHaveCSS("opacity", "1");
  await expect(assistantTime).toHaveCSS("visibility", "visible");
  // At a time, only one message's date and time is shown - user timestamp is now hidden
  await expect(userTime).toHaveCSS("opacity", "0");

  // Click assistant copy button
  await assistantCopyBtn.click();
  await expect(assistantCopyBtn).toHaveClass(/is-copied/);
  await expect(assistantCopyBtn).toHaveAttribute("title", "Copied!");
  const assistantCopyCalls = (await calls(page, "agent.writeClipboard")).filter((c: any) => (c.input?.text || c.input) === "Binary search is an efficient algorithm with O(log n) time complexity.");
  expect(assistantCopyCalls.length).toBeGreaterThanOrEqual(1);

  // Take screenshot for visual verification of copied state
  await page.screenshot({ path: info.outputPath("copy_buttons_copied.png") });

  // Dark mode appearance
  await page.locator("#appearance").selectOption("dark");
  await userMsg.hover();
  await page.screenshot({ path: info.outputPath("copy_buttons_dark.png") });
});

test("short user messages keep attached resources compact", async ({ page, boot }) => {
  await boot({
    storage: JSON.stringify({
      version: 1,
      activeId: "compact-user-message",
      threads: [{
        id: "compact-user-message",
        title: "Compact user message",
        course: courses[0],
        draft: "",
        resources: [],
        prompted: true,
        renamed: true,
        messages: [{
          role: "user",
          text: "study this file",
          resources: [{ kind: "file", id: 501, name: "Giáo trình môn học" }],
        }],
      }],
    }),
  });

  await page.locator('.nav-item[data-view="agent"]').click();
  const message = page.locator(".message.user");
  const bubbleMessage = message.locator(".user-message-bubble");
  const resource = message.locator(".message-resources");
  await expect(message).toBeVisible();
  await expect(bubbleMessage).toBeVisible();
  await expect(resource.locator(".message-resource-type")).toHaveText("File");
  await expect(resource.locator(".message-resource-name")).toHaveText("@Giáo trình môn học");

  const bubble = await bubbleMessage.boundingBox();
  const inner = await page.locator(".messages-inner").boundingBox();
  const text = await message.locator("pre").boundingBox();
  const resourceBox = await resource.boundingBox();
  expect(bubble).not.toBeNull();
  expect(inner).not.toBeNull();
  expect(text).not.toBeNull();
  expect(resourceBox).not.toBeNull();
  expect(bubble!.width).toBeLessThan(inner!.width * 0.6);
  expect(bubble!.x + bubble!.width).toBeCloseTo(inner!.x + inner!.width, 1);
  expect(resourceBox!.y - (text!.y + text!.height)).toBeLessThan(18);

  await message.hover();
  const timestamp = await message.locator(".message-time").boundingBox();
  expect(timestamp).not.toBeNull();
  expect(timestamp!.y).toBeGreaterThanOrEqual(bubble!.y + bubble!.height);
});

test("only the final assistant message in a continuous run exposes a timestamp", async ({ page, boot }) => {
  await boot({
    storage: JSON.stringify({
      version: 1,
      activeId: "assistant-run",
      threads: [{
        id: "assistant-run",
        title: "Assistant run",
        course: courses[0],
        draft: "",
        resources: [],
        prompted: true,
        renamed: true,
        messages: [
          { role: "user", text: "List the course contents" },
          { role: "assistant", text: "I found the course contents." },
          { role: "assistant", kind: "tool", label: "Read course contents", text: "Course contents loaded.", status: "completed" },
          { role: "assistant", text: "The course contains the requested materials." },
        ],
      }],
    }),
  });

  await page.locator('.nav-item[data-view="agent"]').click();
  const assistantMessages = page.locator(".message.message-assistant");
  await expect(assistantMessages).toHaveCount(2);
  const firstActions = assistantMessages.nth(0).locator(".message-actions");
  const finalActions = assistantMessages.nth(1).locator(".message-actions");
  await expect(firstActions).toHaveClass(/is-continuation/);
  await expect(finalActions).not.toHaveClass(/is-continuation/);
  await expect(firstActions.locator(".message-time")).toHaveCSS("display", "none");
  await expect(firstActions.locator(".message-copy-btn")).toHaveCSS("display", "none");
  await assistantMessages.nth(0).hover();
  await expect(firstActions.locator(".message-time")).toHaveCSS("display", "none");
  await assistantMessages.nth(1).hover();
  await expect(finalActions.locator(".message-time")).toHaveCSS("visibility", "visible");
});

test("agent messages have no redundant role labels, project Open in Courses, thin tool message and equal padding on New project", async ({ page, boot }, info) => {
  await boot({
    storage: JSON.stringify({
      version: 1,
      activeId: "ui-refinements",
      threads: [{
        id: "ui-refinements",
        title: "Course inquiry",
        course: courses[0],
        draft: "",
        resources: [],
        prompted: true,
        renamed: true,
        messages: [
          { role: "user", text: "list all pdf files attached in this course" },
          { role: "assistant", kind: "tool", text: "Read course contents · 0.2s", command: "mcp read_course_contents", output: "Found 22 PDF files in course.", status: "completed" },
          { role: "assistant", text: "The course has 22 attached PDF files:\n1. SE362.Q21_.pdf\n2. Chapter 1 - Introduction.pdf" }
        ]
      }]
    })
  });

  // 1. Agent view uses the clickable Codex SVG home icon.
  await page.locator('.nav-item[data-view="agent"]').click();
  const pageTitle = page.locator("#page-title");
  await expect(pageTitle).toHaveClass(/page-title-action/);
  await expect(pageTitle).toHaveAttribute("aria-label", "Codex home");
  await expect(pageTitle.locator(".codex-page-icon")).toHaveCount(1);

  // Switch to Courses view: #page-title displays "Courses" text
  await page.locator('.nav-item[data-view="courses"]').click();
  await expect(pageTitle).not.toHaveClass(/page-title-action/);
  await expect(pageTitle).toHaveText("Courses");

  // Switch back to agent view
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(pageTitle).toHaveClass(/page-title-action/);
  await expect(pageTitle.locator(".codex-page-icon")).toHaveCount(1);

  // 2. New project button has equal margin top and bottom
  const newProjectBtn = page.locator("#new-project");
  await expect(newProjectBtn).toBeVisible();
  const newProjectMarginTop = await newProjectBtn.evaluate((el) => window.getComputedStyle(el).marginTop);
  const newProjectMarginBottom = await newProjectBtn.evaluate((el) => window.getComputedStyle(el).marginBottom);
  expect(newProjectMarginTop).toBe(newProjectMarginBottom);
  expect(newProjectMarginTop).toBe("8px");

  // 3. Project "..." menu contains "Open in Courses" and navigates to the course
  const projectMoreBtn = page.locator(".project-menu-btn").first();
  await expect(projectMoreBtn).toBeVisible();
  await projectMoreBtn.click();
  const openInCoursesItem = page.getByRole("menuitem", { name: "Open in Courses" });
  await expect(openInCoursesItem).toBeVisible();
  await openInCoursesItem.click();

  // Verifies navigation to course view
  await expect(page.locator("#view-course")).toBeVisible();
  await expect(page.locator("#course-detail h1")).toContainText(courses[0].fullname);

  // Go back to agent view to check tool call styling
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#view-agent")).toBeVisible();

  // 4. Tool calls remain compact without a redundant Codex header.
  const toolMsg = page.locator(".message-tool");
  await expect(toolMsg).toBeVisible();
  const toolRole = toolMsg.locator(".message-role");
  await expect(toolRole).toHaveCount(0);

  // Assistant text follows without a redundant role header.
  const assistantTextMsg = page.locator(".message.assistant.message-assistant");
  await expect(assistantTextMsg).toBeVisible();
  await expect(assistantTextMsg.locator(".message-role")).toHaveCount(0);

  const toolCall = page.locator(".tool-call");
  await expect(toolCall).toBeVisible();

  const toolBox = await toolCall.boundingBox();
  expect(toolBox).not.toBeNull();
  // All tool calls share a uniform fixed width (420px) when closed
  expect(toolBox!.width).toBeLessThanOrEqual(420);

  // Take screenshots in light and dark mode for visual verification
  await page.screenshot({ path: info.outputPath("ui_refinements_light.png") });

  await page.locator("#appearance").selectOption("dark");
  await page.screenshot({ path: info.outputPath("ui_refinements_dark.png") });

  // Open the tool call to verify expanded state extends wider to the right
  await toolCall.locator("summary").click();
  const openToolBox = await toolCall.boundingBox();
  expect(openToolBox).not.toBeNull();
  expect(openToolBox!.width).toBeGreaterThan(600);
  await page.screenshot({ path: info.outputPath("ui_refinements_tool_open.png") });
});
