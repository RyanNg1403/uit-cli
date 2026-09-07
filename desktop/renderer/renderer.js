"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const STORE_KEY = "uit-studio.threads.v1";
const CURRENT_SITE = "https://courses.uit.edu.vn";
let streamFrame = null, streamPersistTimer = null, draftPersistTimer = null;
const streamUpdates = new Map();
let messageNodes = new WeakMap();
const timelineStates = new Map();
let composerComposing = false;
const state = {
  sessions: [], courses: [], projects: [], threads: [], activeId: null, view: "courses",
  semester: null, archived: false, selectedCourse: null, listGeneration: 0,
  detailGeneration: 0, readerGeneration: 0, reader: null, objectUrl: null, courseAnnouncements: { key: null, items: [] }, courseContents: { key: null, items: [] },
  courseParticipants: { key: null, items: [] }, courseGrades: { key: null, items: [] }, activeCourseTab: "materials",
  menuResource: null, storageError: false, storageUnreadable: false, authBusy: false, loginFormOpen: false,
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function button(text, className, onClick) {
  const element = node("button", className, text);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}
function iconButton(label, className, icon, onClick) {
  const element = button("", className, onClick);
  element.setAttribute("aria-label", label);
  element.title = label;
  element.append(icon);
  return element;
}
function refreshIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3");
  svg.append(path);
  return svg;
}
function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m4.5 3 3 3-3 3");
  svg.append(path);
  return svg;
}
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (!error) return "Unknown error";
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error);
      if (parsed?.error?.message) return parsed.error.message;
      if (parsed?.message) return parsed.message;
    } catch {}
    return error;
  }
  if (error.error?.message) return error.error.message;
  return String(error.message || error);
}
function uid() { return crypto.randomUUID(); }
function identity(ref) { return JSON.stringify([ref.baseUrl, String(ref.userId)]); }
function courseKey(course) { return JSON.stringify([course.baseUrl, String(course.userId), Number(course.id)]); }
function courseRef(course) { return { courseId: course.id, baseUrl: course.baseUrl, userId: course.userId }; }
function connected(ref) { return !!ref && state.sessions.some((session) => identity(session) === identity(ref)); }
function activeThread() { return state.threads.find((thread) => thread.id === state.activeId && visibleThread(thread)); }
function visibleThread(thread) { return connected(thread?.course || thread?.owner); }
function hasPrompt(thread) { return thread.prompted ?? thread.messages.some((message) => message.role === "user"); }
function addProject(course) {
  if (!state.projects.some((project) => courseKey(project) === courseKey(course))) state.projects.push(courseSnapshot(course));
}
function discardUnsent(exceptId = null) {
  state.threads = state.threads.filter((thread) => hasPrompt(thread) || thread.id === exceptId);
  if (!state.threads.some((thread) => thread.id === state.activeId)) state.activeId = null;
}
function siteLabel(course) { return course.siteLabel || (course.baseUrl === CURRENT_SITE ? "Current Moodle" : course.baseUrl?.endsWith("/sdh") ? "Graduate Moodle" : "Legacy Moodle"); }
function semesterOf(course) {
  if (!course?.semester?.id) return { id: "unknown", label: "Unknown semester", sortOrder: -1, source: "unknown" };
  const rawLabel = String(course.semester.label || "");
  const cleanLabel = rawLabel.replace(/\s*\(inferred[^\)]*\)/gi, "").trim();
  const rawId = String(course.semester.id);
  const cleanId = rawId.startsWith("startdate-") ? rawId.replace(/^startdate-/, "") : rawId;
  return {
    ...course.semester,
    id: cleanId,
    label: cleanLabel || rawLabel,
  };
}
function semesterGroups(courses) {
  const groups = new Map();
  for (const course of courses) {
    const semester = semesterOf(course);
    if (!groups.has(semester.id)) groups.set(semester.id, { ...semester, courses: [] });
    groups.get(semester.id).courses.push(course);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === "unknown") return 1;
    if (b.id === "unknown") return -1;
    return Number(b.sortOrder) - Number(a.sortOrder) || String(b.label).localeCompare(String(a.label));
  });
}
// Display grouping: semesters from different sources (category vs inferred from
// start date) that fall in the same calendar year merge into one card.
function yearGroups(courses) {
  const groups = new Map();
  for (const course of courses) {
    const semester = semesterOf(course);
    const year = semester.id === "unknown" ? null : /(\d{4})/.exec(semester.label)?.[1];
    const key = year ? `year-${year}` : semester.id;
    if (!groups.has(key)) groups.set(key, { id: key, label: year || semester.label, sortOrder: semester.sortOrder, courses: [] });
    const group = groups.get(key);
    group.courses.push(course);
    if (Number(semester.sortOrder) > Number(group.sortOrder)) group.sortOrder = semester.sortOrder;
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === "unknown") return 1;
    if (b.id === "unknown") return -1;
    return Number(b.sortOrder) - Number(a.sortOrder) || String(b.label).localeCompare(String(a.label));
  });
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $("#toast").hidden = true; }, 6000);
}
function appError(message) { $("#app-error").textContent = message; $("#app-error").hidden = !message; }

// Persist only renderer-owned state, never session objects or bridge credentials.
function safeResource(resource) {
  let fileUrl = resource.fileUrl;
  if (fileUrl) {
    try {
      const url = new URL(fileUrl);
      url.username = ""; url.password = "";
      for (const key of [...url.searchParams.keys()]) if (/token|sesskey|password|auth/i.test(key)) url.searchParams.delete(key);
      fileUrl = url.href;
    } catch { fileUrl = undefined; }
  }
  return { kind: resource.referenceKind || resource.kind, id: resource.id, moduleId: resource.moduleId, fileUrl, name: resource.name };
}
function courseSnapshot(course) {
  return { id: course.id, baseUrl: course.baseUrl, userId: course.userId, shortname: course.shortname, fullname: course.fullname, semester: semesterOf(course), siteLabel: siteLabel(course) };
}
function persist() {
  clearTimeout(streamPersistTimer); clearTimeout(draftPersistTimer);
  streamPersistTimer = null; draftPersistTimer = null;
  if (state.storageUnreadable) return;
  try {
    const threads = state.threads.filter(hasPrompt).map((thread) => ({
      id: thread.id, owner: thread.owner, course: thread.course, title: thread.title, renamed: thread.renamed, model: thread.model, effort: thread.effort,
      draft: thread.draft, resources: thread.resources.map(safeResource),
      messages: thread.messages.filter((message) => message.kind !== "reasoning" && message.label !== "Thought process"),
      threadId: thread.threadId, turnId: thread.turnId, cwd: thread.cwd, started: thread.started, prompted: true, forkSource: thread.forkSource,
      archived: Boolean(thread.archived),
      createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      interrupted: thread.busy || thread.interrupted,
    }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, activeId: threads.some((thread) => thread.id === state.activeId) ? state.activeId : null, projects: state.projects, threads, collapsed: [...collapsedProjects] }));
    if (state.storageError) { state.storageError = false; appError(""); }
  } catch {
    state.storageError = true;
    appError("Thread changes could not be saved on this device. Keep this window open; local storage may be full or unavailable.");
  }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!saved) return;
    if (saved.version !== 1 || !Array.isArray(saved.threads)) throw new Error("Unsupported thread index");
    if (!saved.threads.every((thread) => thread && typeof thread.id === "string" && typeof thread.title === "string" &&
      typeof (thread.course || thread.owner)?.baseUrl === "string" && Number.isSafeInteger(Number((thread.course || thread.owner)?.userId)) && Number((thread.course || thread.owner)?.userId) > 0 &&
      Array.isArray(thread.messages) && thread.messages.every((message) => message && typeof message.text === "string" && ["user", "assistant", "event"].includes(message.role) &&
        (message.resources === undefined || Array.isArray(message.resources) && message.resources.every((resource) => resource && typeof resource.name === "string"))) &&
      Array.isArray(thread.resources) && thread.resources.every((resource) => resource && typeof resource.name === "string" && ["module", "file", "assignment", "announcement"].includes(resource.kind) && Number.isSafeInteger(resource.id) && resource.id > 0))) throw new Error("Invalid saved thread");
    state.threads = saved.threads.filter(hasPrompt).map((thread) => ({
      ...thread,
      archived: Boolean(thread.archived),
      messages: thread.messages
        .filter((message) => message.kind !== "reasoning" && message.label !== "Thought process")
        .map((message) => message.kind === "turn-state" && message.status === "working"
          ? { ...message, status: "stopped", label: "Interrupted", text: "This turn ended when UIT Studio closed. Send a message to continue." }
          : message),
      draft: String(thread.draft || ""), busy: false, pending: false, stopping: false,
      branching: false, taskId: null, streamItem: null, approvals: [], completedTurns: new Set(),
    }));
    if (saved.projects !== undefined && (!Array.isArray(saved.projects) || !saved.projects.every((project) => project && typeof project.baseUrl === "string" && Number.isSafeInteger(project.id) && project.id > 0 && Number(project.userId) > 0))) throw new Error("Invalid saved projects");
    state.projects = (saved.projects || []).map((project) => {
      const { archived: _archived, ...rest } = project;
      return rest;
    });
    collapsedProjects.clear();
    if (Array.isArray(saved.collapsed)) for (const key of saved.collapsed) if (typeof key === "string" && key) collapsedProjects.add(key);
    for (const thread of state.threads) if (thread.course) addProject(thread.course);
    state.activeId = saved.activeId;
  } catch {
    state.storageUnreadable = true;
    appError("Saved threads could not be read. Existing storage is untouched. New changes will not be saved; keep this window open to retain them.");
  }
}

function showView(view) {
  if (view !== "agent") discardUnsent();
  if (view !== "course") state.detailGeneration++;
  state.view = view;
  for (const name of ["courses", "course", "agent"]) $("#view-" + name).hidden = name !== view;
  $("#page-title").textContent = view === "agent" ? "Codex" : "Courses";
  $$(".nav-item[data-view]").forEach((item) => {
    if (item.dataset.view === (view === "course" ? "courses" : view)) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  if (view === "agent") renderConversation();
  renderRail();
  window.uitSidebar.closeMobile();
}
function renderRail() {
  const nav = $("#course-nav");
  nav.replaceChildren();
  const agent = state.view === "agent";
  $("#new-project").hidden = !agent;
  $("#rail-title").textContent = agent ? "Projects / Threads" : "Courses";
  const showArchived = $("#show-archived");
  if (showArchived) {
    showArchived.hidden = !agent;
    showArchived.setAttribute("aria-pressed", String(state.archived));
  }
  const threads = state.threads.filter((thread) => hasPrompt(thread) && visibleThread(thread) && (agent ? !!thread.archived === !!state.archived : true));
  const projects = agent ? state.projects.filter(connected).map((project) => {
    const live = state.courses.find((course) => courseKey(course) === courseKey(project));
    const merged = { ...(live || project), ...project };
    if (live?.semester) merged.semester = live.semester;
    return merged;
  }) : state.courses;
  const groups = agent ? yearGroups(projects) : semesterGroups(projects);
  for (const group of groups) {
    const section = node("section", "semester-nav");
    section.dataset.semesterId = group.id;
    section.append(node("h3", "", group.label));
    for (const course of group.courses) {
      const project = node("div", "project");
      project.dataset.courseKey = courseKey(course);
      const expanded = agent && !collapsedProjects.has(courseKey(course));
      if (expanded) project.classList.add("expanded");
      project.append(projectLine(course, true));
      if (expanded) {
        const list = node("div", "thread-list");
        for (const thread of threads.filter((item) => item.course && courseKey(item.course) === courseKey(course))) list.append(threadRow(thread));
        if (list.childElementCount) project.append(list);
      }
      section.append(project);
    }
    if (section.childElementCount > 1) nav.append(section);
  }
  if (agent) {
    const unbound = threads.filter((thread) => !thread.course);
    if (unbound.length) {
      const group = node("section", "semester-nav");
      group.append(node("h3", "", "Unassigned drafts"));
      unbound.forEach((thread) => group.append(threadLink(thread)));
      nav.append(group);
    }
  }
  if (!nav.childElementCount) nav.append(node("p", "muted", state.sessions.length ? agent ? "No projects" : "No courses" : "Not connected"));
}
let railMenu = null;
function closeRailMenu() {
  railMenu?.remove();
  railMenu = null;
}
function openRailMenu(anchor, actions) {
  closeRailMenu();
  const menu = node("div", "rail-menu");
  menu.setAttribute("role", "menu");
  for (const action of actions) {
    const item = button(action.label, action.danger ? "danger-menu-item" : "", () => {
      if (action.disabled) return;
      closeRailMenu();
      action.run();
    });
    if (action.disabled) {
      item.disabled = true;
      item.classList.add("disabled-action");
      if (action.title) item.title = action.title;
    }
    item.setAttribute("role", "menuitem");
    menu.append(item);
  }
  document.body.append(menu);
  railMenu = menu;
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${Math.max(8, Math.min(box.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`;
  ($("button:not(:disabled)", menu) || $("button", menu))?.focus();
}
function confirmPermanentDeletion(title, description) {
  const dialog = $("#delete-dialog");
  $("#delete-title").textContent = title;
  $("#delete-description").textContent = description;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (confirmed) => {
      $("#cancel-delete").removeEventListener("click", cancel);
      $("#confirm-delete").removeEventListener("click", confirm);
      dialog.removeEventListener("cancel", cancelEvent);
      if (dialog.open) dialog.close();
      resolve(confirmed);
    };
    const cancel = () => finish(false);
    const confirm = () => finish(true);
    const cancelEvent = (event) => { event.preventDefault(); finish(false); };
    $("#cancel-delete").addEventListener("click", cancel);
    $("#confirm-delete").addEventListener("click", confirm);
    dialog.addEventListener("cancel", cancelEvent);
    $("#cancel-delete").focus();
  });
}
function removeLocalThread(thread) {
  state.threads = state.threads.filter((item) => item !== thread);
  if (state.activeId === thread.id) state.activeId = null;
}
async function deleteThread(thread) {
  if (!thread || thread.stopping || thread.deleting) return;
  if (thread.locked) {
    toast("Cannot delete: thread is locked in an external session.");
    return;
  }
  if (thread.busy || thread.pending || thread.branching) {
    toast("Stop active work in this thread before deleting it.");
    return;
  }
  const confirmed = await confirmPermanentDeletion("Delete this thread permanently?", "This thread and any Codex branches created from it will be removed and cannot be resumed in UIT Studio, Codex CLI, or Codex App. Downloaded course files will remain.");
  if (!confirmed || !state.threads.includes(thread)) return;
  thread.deleting = true; renderRail();
  try {
    if (thread.threadId) await window.uit.agent.delete({ threadId: thread.threadId });
    removeLocalThread(thread);
    persist(); renderRail(); renderConversation();
    toast("Thread permanently deleted.");
  } catch (error) {
    // If the native thread was already gone or not found, remove it locally idempotently.
    if (/no rollout|not found|unknown|no such|already deleted|does not exist/i.test(errorText(error))) {
      removeLocalThread(thread);
      persist(); renderRail(); renderConversation();
      toast("Thread permanently deleted.");
      return;
    }
    if (state.threads.includes(thread)) thread.deleting = false;
    renderRail();
    toast(`Could not delete this thread. ${errorText(error)} Try again.`);
  }
}
async function deleteProject(project) {
  const canonical = state.projects.find((item) => courseKey(item) === courseKey(project));
  if (!canonical) return;
  const targets = state.threads.filter((thread) => thread.course && courseKey(thread.course) === courseKey(project));
  if (targets.some((thread) => thread.busy || thread.pending || thread.branching || thread.stopping || thread.deleting)) {
    toast("Stop active work in this project before deleting it."); return;
  }
  const confirmed = await confirmPermanentDeletion("Delete this project permanently?", targets.length
    ? `All ${targets.length} Codex thread${targets.length === 1 ? "" : "s"} in this project will be deleted and cannot be resumed in Codex CLI or Codex App. The course workspace and downloaded files will remain.`
    : "This project has no threads. It will be removed from UIT Studio. The course itself is unaffected.");
  if (!confirmed || !state.projects.includes(canonical)) return;
  targets.forEach((thread) => { thread.deleting = true; }); renderRail();
  let deleted = 0;
  const failures = [];
  for (const thread of targets) {
    if (!state.threads.includes(thread)) { deleted++; continue; }
    try {
      if (thread.threadId) await window.uit.agent.delete({ threadId: thread.threadId });
      removeLocalThread(thread); deleted++;
    } catch (error) {
      if (/no rollout|not found|unknown|no such|already deleted|does not exist/i.test(errorText(error))) {
        removeLocalThread(thread); deleted++;
      } else {
        thread.deleting = false; failures.push(errorText(error));
      }
    }
  }
  if (!state.threads.some((thread) => thread.course && courseKey(thread.course) === courseKey(project))) state.projects = state.projects.filter((item) => item !== canonical);
  persist(); renderRail(); renderConversation();
  if (failures.length) toast(`${deleted} thread${deleted === 1 ? "" : "s"} deleted; ${failures.length} could not be deleted. Try again.`);
  else toast(targets.length ? "Project and its Codex threads permanently deleted." : "Project removed.");
}
const collapsedProjects = new Set();
function projectLine(course, allowAdd) {
  const agent = state.view === "agent";
  const key = courseKey(course);
  const line = node("div", "project-line");
  const open = button("", agent ? "project-link project-collapse" : "project-link", () => {
    // The title only opens or closes the thread list; it never selects or creates a thread.
    if (agent) {
      collapsedProjects.has(key) ? collapsedProjects.delete(key) : collapsedProjects.add(key);
      persist();
      renderRail();
    } else openCourse(course);
  });
  open.title = agent ? `Show/hide threads for ${course.shortname || course.fullname}` : `${course.fullname} / ${siteLabel(course)} / Account ${course.userId}`;
  if (agent) {
    open.setAttribute("aria-expanded", String(!collapsedProjects.has(key)));
    const icon = node("span", "project-chevron");
    icon.append(chevron());
    open.append(icon);
  }
  open.append(node("span", "project-name", course.shortname || course.fullname));
  if (state.selectedCourse && courseKey(state.selectedCourse) === courseKey(course) && state.view === "course") open.setAttribute("aria-current", "page");
  line.append(open);
  if (agent) {
    if (allowAdd) {
      const add = button("+", "icon-button project-new-thread", () => newThread(course));
      add.setAttribute("aria-label", `New thread in ${course.shortname || course.fullname}`);
      add.title = "New thread";
      line.append(add);
    }
    const more = button("...", "icon-button project-menu-btn", () => openRailMenu(more, [
      { label: "Delete permanently", danger: true, run: () => deleteProject(course) },
    ]));
    more.setAttribute("aria-label", `Actions for ${course.shortname || course.fullname}`);
    more.dataset.railMenu = "";
    more.title = "Project actions";
    line.append(more);
  }
  return line;
}
function openRenameDialog(thread) {
  if (!thread) return;
  if (thread.locked) {
    toast("Cannot rename: thread is locked in an external session.");
    return;
  }
  $("#rename-dialog").dataset.taskId = thread.id;
  $("#thread-name").value = thread.title;
  $("#rename-dialog").showModal();
  $("#thread-name").select();
}

function threadRow(thread) {
  const wrap = node("div", "thread thread-row");
  const more = button("...", "icon-button thread-menu-btn", async () => {
    let isLocked = Boolean(thread.locked);
    if (thread.threadId && thread.locked === undefined) {
      try {
        const res = await window.uit?.agent?.lockStatus?.(thread.threadId);
        if (res && typeof res.locked === "boolean") {
          thread.locked = res.locked;
          isLocked = res.locked;
        }
      } catch (_) {}
    }
    openRailMenu(more, [
      {
        label: "Rename",
        disabled: isLocked,
        title: isLocked ? "Thread is locked in an external session (read-only)" : undefined,
        run: () => openRenameDialog(thread)
      },
      { label: "Branch", run: () => branchThread(thread) },
      {
        label: "Delete permanently",
        danger: true,
        disabled: isLocked,
        title: isLocked ? "Thread is locked in an external session (read-only)" : undefined,
        run: () => deleteThread(thread)
      },
    ]);
  });
  more.setAttribute("aria-label", `Actions for ${thread.title}`);
  more.dataset.railMenu = "";
  more.title = "Thread actions";
  wrap.append(threadLink(thread), more);
  return wrap;
}
function threadLink(thread) {
  const link = button("", "thread-link", () => selectThread(thread.id));
  link.dataset.taskId = thread.id;
  link.title = thread.title;
  link.append(node("span", "", thread.title), node("span", "thread-state", thread.deleting ? "Deleting" : thread.busy ? "Working" : !thread.started ? "Draft" : ""));
  if (thread.id === state.activeId) link.setAttribute("aria-current", "page");
  return link;
}

async function loadCourses(refresh = false) {
  const generation = ++state.listGeneration;
  $("#refresh-courses").disabled = true;
  $("#course-grid").replaceChildren(node("p", "empty", refresh ? "Refreshing courses..." : "Loading courses..."));
  try {
    const courses = await (refresh ? window.uit.courses.refresh() : window.uit.courses.list());
    if (generation !== state.listGeneration) return;
    state.courses = courses.map((course) => ({ ...course, userId: course.userId ?? state.sessions.find((session) => session.baseUrl === course.baseUrl)?.userId })).filter(connected);
    const status = await window.uit.session.status();
    if (generation !== state.listGeneration) return;
    renderDiscovery(status);
    if (!state.storageError && !state.storageUnreadable) appError((status.portalErrors || []).map((entry) => `${entry.message} Reconnect this portal in Course accounts.`).join("\n"));
    const groups = semesterGroups(state.courses);
    // Missing Moodle dates must not hide courses behind an inferred legacy year.
    // Keep an explicit filter on refresh; new accounts and invalid filters show all.
    if (state.semester !== "all" && !groups.some((group) => group.id === state.semester)) state.semester = "all";
    const select = $("#semester-select");
    select.replaceChildren();
    const all = node("option", "", "All semesters"); all.value = "all"; select.append(all);
    for (const group of groups) {
      const option = node("option", "", group.label);
      option.value = group.id;
      select.append(option);
    }
    select.value = state.semester || "";
    select.disabled = !groups.length;
    renderCourseList(); renderRail();
    if (state.view === "agent") renderConversation();
  } catch (error) {
    if (generation !== state.listGeneration) return;
    renderLoadError($("#course-grid"), "Courses could not be loaded", error, () => loadCourses(true));
    try { const status = await window.uit.session.status(); if (generation === state.listGeneration) renderDiscovery(status); } catch { /* Keep the original discovery failure visible. */ }
  } finally {
    if (generation === state.listGeneration) $("#refresh-courses").disabled = false;
  }
}
function renderCourseList() {
  const list = $("#course-grid");
  list.replaceChildren();
  if (!state.sessions.length) {
    const empty = node("div", "empty");
    empty.append(button("Connect UIT account", "primary-button", openLogin));
    list.append(empty); return;
  }
  const query = $("#course-search").value.trim().toLocaleLowerCase();
  const courses = state.courses.filter((course) => (query || state.semester === "all" || semesterOf(course).id === state.semester) && `${course.fullname} ${course.shortname} ${siteLabel(course)}`.toLocaleLowerCase().includes(query));
  const heading = node("div", "list-heading");
  heading.append(node("h2", "", query ? "Search across all semesters" : state.semester === "all" ? "All semesters" : semesterGroups(state.courses).find((group) => group.id === state.semester)?.label || "Courses"), node("span", "list-count", `${courses.length} course${courses.length === 1 ? "" : "s"}`));
  list.append(heading);
  if (!query && state.semester !== "all" && courses.length < state.courses.length) {
    const notice = node("div", "course-filter-notice");
    notice.append(node("span", "muted", `${state.courses.length - courses.length} courses in other or unknown semesters are hidden. `), button("Show all semesters", "text-button", () => {
      state.semester = "all";
      $("#semester-select").value = "all";
      renderCourseList();
    }));
    list.append(notice);
  }
  for (const group of semesterGroups(courses)) {
    if (query || state.semester === "all") list.append(node("h3", "section-label", group.label));
    for (const course of group.courses) {
      const row = button("", "course-row", () => openCourse(course));
      row.dataset.courseKey = courseKey(course);
      const copy = node("span", "course-copy");
      copy.append(node("strong", "", course.fullname), node("small", "", `${siteLabel(course)} / Account ${course.userId}${course.discoveredVia === "url" ? " / Linked by URL" : ""}`));
      row.append(node("span", "course-code", course.shortname), copy);
      const card = node("div", "course-card");
      card.append(row);
      list.append(card);
    }
  }
  if (!courses.length) list.append(node("p", "empty", query ? "No matching courses" : "No courses"));
}
function renderLoadError(container, title, error, retry) {
  const box = node("div", "load-error");
  box.setAttribute("role", "alert");
  box.append(node("p", "", `${title}. ${errorText(error)}`), button("Retry", "secondary-button", retry), button("Manage accounts", "text-button", openLogin));
  container.replaceChildren(box);
}
function isLecturerRole(role) {
  const r = String(role || "").toLowerCase();
  return (
    r.includes("teacher") ||
    r.includes("gvlt") ||
    r.includes("gvth") ||
    r.includes("giảng viên") ||
    r.includes("giáo viên") ||
    r.includes("lecturer") ||
    r.includes("instructor") ||
    r.includes("professor") ||
    r.includes("manager") ||
    r.includes("quản lý") ||
    r.includes("creator")
  );
}
function isTaRole(role) {
  const r = String(role || "").toLowerCase();
  return r.includes("ta") || r.includes("assistant") || r.includes("trợ giảng");
}
function isStudentRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return (
    !r ||
    r === "student" ||
    r === "học viên" ||
    r === "sinh viên" ||
    r.includes("student") ||
    r.includes("học viên") ||
    r.includes("sinh viên")
  );
}
function memberPriority(member) {
  const roles = (member?.roles || []).map((r) => String(r).toLowerCase());
  if (roles.some(isLecturerRole)) return 0;
  if (roles.some(isTaRole)) return 1;
  return 2;
}
function roleLabel(role) {
  const r = String(role || "").toLowerCase().trim();
  if (r === "gvth") return "GVTH";
  if (
    r === "gvlt" ||
    r === "editingteacher" ||
    r === "teacher" ||
    r === "giảng viên" ||
    r === "giáo viên" ||
    r === "lecturer" ||
    r === "instructor" ||
    r === "professor"
  ) {
    return "GVLT";
  }
  if (r === "teacherassistant" || r === "trợ giảng" || r === "ta") return "TA";
  if (isLecturerRole(r)) return "GVLT";
  return role;
}
function roleClass(role) {
  if (isLecturerRole(role)) return "role-teacher";
  if (isTaRole(role)) return "role-ta";
  return "role-student";
}
function defaultAvatar(isTeacher = false) {
  const span = node("span", `member-avatar${isTeacher ? " teacher-avatar" : ""}`);
  span.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  if (isTeacher) {
    path.setAttribute("d", "M10.394 2.08a1 1 0 00-.788 0l-7 3a1 1 0 000 1.84L5.25 8.051a10.977 10.977 0 01-1.2 4.195 1 1 0 00.916 1.455c1.47 0 2.766-.56 3.73-1.488.964.928 2.26 1.488 3.73 1.488a1 1 0 00.916-1.455 10.977 10.977 0 01-1.2-4.195l2.644-1.131a1 1 0 000-1.84l-7-3zM10 10.5a8.977 8.977 0 01-3.666-1.52L10 7.42l3.666 1.56A8.977 8.977 0 0110 10.5z");
  } else {
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", "M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z");
    path.setAttribute("clip-rule", "evenodd");
  }
  svg.append(path);
  span.append(svg);
  return span;
}
function formatLastAccess(value) {
  if (!value || value === "0" || value === "-" || value === "Never") return null;
  const str = String(value).trim();
  if (/^\d{9,12}$/.test(str)) {
    const sec = Number(str);
    const date = new Date(sec * 1000);
    if (!isNaN(date.getTime())) {
      const now = Date.now();
      const diffSec = Math.floor((now - date.getTime()) / 1000);
      if (diffSec < 60) return "Just now";
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
      if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} days ago`;
      return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    }
  }
  return str;
}
async function loadMembers(container, course, generation, refresh = false) {
  const key = courseKey(course);
  if (!refresh && state.courseParticipants.key === key) {
    displayMembers(container, state.courseParticipants.items, course);
    return;
  }
  container.replaceChildren(node("p", "muted", "Loading members..."));
  try {
    let participants = await window.uit.courses.participants(courseRef(course));
    if (generation !== state.detailGeneration) return;
    participants = Array.isArray(participants) ? [...participants] : [];
    if (Array.isArray(course.contacts)) {
      for (const contact of course.contacts) {
        if (contact && contact.fullname && !participants.some((p) => p.fullname.toLowerCase() === contact.fullname.toLowerCase())) {
          participants.unshift({
            id: contact.id || 0,
            fullname: contact.fullname,
            roles: ["GVLT"],
            email: contact.email || undefined,
          });
        }
      }
    }
    state.courseParticipants = { key, items: participants };
    displayMembers(container, state.courseParticipants.items, course);
  } catch (error) {
    if (generation === state.detailGeneration) {
      renderLoadError(container, "Members could not be loaded", error, () => loadMembers(container, course, generation, true));
    }
  }
}
function displayMembers(container, members, course) {
  container.replaceChildren();
  const header = node("div", "members-header");
  const count = members.length;
  const countSpan = node("span", "members-count", `${count} ${count === 1 ? "member" : "members"}`);

  const searchWrap = node("label", "members-search-field");
  const searchInput = node("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search members by name or role...";
  searchInput.setAttribute("aria-label", "Search members");
  searchWrap.append(searchInput);

  header.append(countSpan, searchWrap);
  container.append(header);

  const listContainer = node("div", "members-list");
  container.append(listContainer);

  const sortedMembers = [...members].sort((a, b) => {
    const pa = memberPriority(a);
    const pb = memberPriority(b);
    if (pa !== pb) return pa - pb;
    return (a.fullname || "").localeCompare(b.fullname || "", "vi", { sensitivity: "base" });
  });

  const renderList = (filterText = "") => {
    listContainer.replaceChildren();
    const query = filterText.toLowerCase().trim();
    const filtered = query
      ? sortedMembers.filter((m) =>
          (m.fullname && m.fullname.toLowerCase().includes(query)) ||
          m.roles?.some((r) => r.toLowerCase().includes(query) || roleLabel(r).toLowerCase().includes(query)) ||
          m.groups?.some((g) => g.toLowerCase().includes(query)) ||
          (m.email && m.email.toLowerCase().includes(query))
        )
      : sortedMembers;

    if (!filtered.length) {
      listContainer.append(node("p", "empty", query ? "No matching members." : "No members found."));
      return;
    }

    for (const member of filtered) {
      const card = node("div", "member-card");
      const isTeacher = memberPriority(member) === 0;
      card.append(defaultAvatar(isTeacher));

      const info = node("div", "member-info");
      const nameRow = node("div", "member-name-row");
      nameRow.append(node("strong", "member-name", member.fullname));

      const nonStudentRoles = (member.roles || []).filter((r) => !isStudentRole(r));
      for (const role of nonStudentRoles) {
        nameRow.append(node("span", `role-badge ${roleClass(role)}`, roleLabel(role)));
      }
      info.append(nameRow);

      const metaRow = node("div", "member-meta-row");
      if (member.email) {
        const mailLink = node("a", "member-email", member.email);
        mailLink.href = `mailto:${member.email}`;
        metaRow.append(mailLink);
      }
      if (member.groups && member.groups.length) {
        metaRow.append(node("span", "member-group", member.groups.join(", ")));
      }
      const formattedAccess = formatLastAccess(member.lastAccess);
      if (formattedAccess) {
        metaRow.append(node("span", "member-access", `Last access: ${formattedAccess}`));
      }
      if (metaRow.childElementCount) info.append(metaRow);

      card.append(info);
      listContainer.append(card);
    }
  };

  searchInput.addEventListener("input", (e) => renderList(e.target.value));
  renderList();
}
async function loadGrades(container, course, generation, refresh = false) {
  const key = courseKey(course);
  if (!refresh && state.courseGrades.key === key) {
    displayGrades(container, state.courseGrades.items, course);
    return;
  }
  container.replaceChildren(node("p", "muted", "Loading grades..."));
  try {
    const grades = await window.uit.courses.grades(courseRef(course));
    if (generation !== state.detailGeneration) return;
    state.courseGrades = { key, items: grades || [] };
    displayGrades(container, state.courseGrades.items, course);
  } catch (error) {
    if (generation === state.detailGeneration) {
      renderLoadError(container, "Grades could not be loaded", error, () => loadGrades(container, course, generation, true));
    }
  }
}
function displayGrades(container, items, course) {
  container.replaceChildren();
  if (!items || !items.length) {
    container.append(node("p", "empty", "No grade items reported for this course."));
    return;
  }

  const totalItem = items.find((i) => {
    const n = (i.item || "").toLowerCase();
    return n.includes("course total") || n.includes("tổng điểm khóa học") || n.includes("tổng điểm");
  });

  if (totalItem && totalItem.grade) {
    const card = node("div", "grades-total-card");
    const info = node("div", "grades-total-info");
    info.append(node("h3", "", totalItem.item));
    const scoreDiv = node("div", "grades-total-score", totalItem.grade);
    if (totalItem.max) scoreDiv.append(node("span", "grades-total-max", `/ ${totalItem.max}`));
    info.append(scoreDiv);
    card.append(info);
    if (totalItem.percentage) {
      card.append(node("span", "grades-total-badge", totalItem.percentage));
    }
    container.append(card);
  }

  const table = node("table", "grades-table");
  const thead = node("thead");
  const headRow = node("tr");
  headRow.append(
    node("th", "", "Grade Item"),
    node("th", "", "Grade"),
    node("th", "", "Percentage")
  );
  thead.append(headRow);
  table.append(thead);

  const tbody = node("tbody");
  for (const item of items) {
    const tr = node("tr");
    const tdItem = node("td");
    tdItem.append(node("div", "grade-item-name", item.item));
    if (item.feedback) {
      tdItem.append(node("div", "grade-feedback", item.feedback));
    }

    const tdGrade = node("td");
    const scoreSpan = node("span", "grade-score", item.grade || "—");
    tdGrade.append(scoreSpan);
    if (item.max && item.grade && item.grade !== "—") {
      tdGrade.append(node("span", "grade-max", `/ ${item.max}`));
    }

    const tdPerc = node("td");
    tdPerc.append(node("span", "grade-percentage", item.percentage || "—"));

    tr.append(tdItem, tdGrade, tdPerc);
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}
async function openCourse(course, refresh = false) {
  if (!connected(course)) { toast("Connect this course's account before opening it."); return; }
  state.selectedCourse = course;
  showView("course");
  const generation = ++state.detailGeneration;
  const detail = $("#course-detail");
  detail.replaceChildren();
  detail.append(node("p", "eyebrow", `${semesterOf(course).label} / ${siteLabel(course)} / ${course.shortname}`), node("h1", "", course.fullname));
  if (course.summary) detail.append(node("p", "course-description", course.summary));
  const actions = node("div", "detail-actions");
  actions.append(button("New Thread", "primary-button", () => newThread(course)), iconButton("Refresh resources", "secondary-button icon-action", refreshIcon(), () => openCourse(course, true)), button("Open in Moodle", "secondary-button", () => openMoodle(course, `${course.baseUrl}/course/view.php?id=${course.id}`)));
  detail.append(actions);
  if (refresh) {
    const status = node("div", "muted", "Refreshing resources..."); detail.append(status);
    state.courseContents = { key: null, items: [] };
    state.courseAnnouncements = { key: null, items: [] };
    state.courseParticipants = { key: null, items: [] };
    state.courseGrades = { key: null, items: [] };
    try { await window.uit.courses.refresh(courseRef(course)); }
    catch (error) {
      if (generation === state.detailGeneration) renderLoadError(status, "Resources could not be refreshed", error, () => openCourse(course, true));
      return;
    }
    if (generation !== state.detailGeneration) return;
    status.remove();
  }

  const activeTab = state.activeCourseTab || "materials";
  const tabsNav = node("nav", "course-tabs");
  tabsNav.setAttribute("role", "tablist");
  tabsNav.setAttribute("aria-label", "Course navigation");

  const tabButtons = {
    materials: button("Materials", `course-tab ${activeTab === "materials" ? "active" : ""}`, () => selectTab("materials")),
    members: button("Members", `course-tab ${activeTab === "members" ? "active" : ""}`, () => selectTab("members")),
    grades: button("Grades", `course-tab ${activeTab === "grades" ? "active" : ""}`, () => selectTab("grades")),
  };
  tabButtons.materials.setAttribute("role", "tab");
  tabButtons.materials.id = "tab-materials";
  tabButtons.materials.setAttribute("aria-selected", String(activeTab === "materials"));
  tabButtons.materials.setAttribute("aria-controls", "panel-materials");

  tabButtons.members.setAttribute("role", "tab");
  tabButtons.members.id = "tab-members";
  tabButtons.members.setAttribute("aria-selected", String(activeTab === "members"));
  tabButtons.members.setAttribute("aria-controls", "panel-members");

  tabButtons.grades.setAttribute("role", "tab");
  tabButtons.grades.id = "tab-grades";
  tabButtons.grades.setAttribute("aria-selected", String(activeTab === "grades"));
  tabButtons.grades.setAttribute("aria-controls", "panel-grades");

  tabsNav.append(tabButtons.materials, tabButtons.members, tabButtons.grades);
  detail.append(tabsNav);

  const panelMaterials = node("div", "course-tab-panel");
  panelMaterials.id = "panel-materials";
  panelMaterials.setAttribute("role", "tabpanel");
  panelMaterials.setAttribute("aria-labelledby", "tab-materials");
  panelMaterials.hidden = activeTab !== "materials";

  const panelMembers = node("div", "course-tab-panel");
  panelMembers.id = "panel-members";
  panelMembers.setAttribute("role", "tabpanel");
  panelMembers.setAttribute("aria-labelledby", "tab-members");
  panelMembers.hidden = activeTab !== "members";

  const panelGrades = node("div", "course-tab-panel");
  panelGrades.id = "panel-grades";
  panelGrades.setAttribute("role", "tabpanel");
  panelGrades.setAttribute("aria-labelledby", "tab-grades");
  panelGrades.hidden = activeTab !== "grades";

  detail.append(panelMaterials, panelMembers, panelGrades);

  function selectTab(tabKey) {
    state.activeCourseTab = tabKey;
    for (const [key, btn] of Object.entries(tabButtons)) {
      const active = key === tabKey;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    }
    panelMaterials.hidden = tabKey !== "materials";
    panelMembers.hidden = tabKey !== "members";
    panelGrades.hidden = tabKey !== "grades";
    if (tabKey === "members") loadMembers(panelMembers, course, generation);
    if (tabKey === "grades") loadGrades(panelGrades, course, generation);
  }

  if (activeTab === "members") loadMembers(panelMembers, course, generation);
  else if (activeTab === "grades") loadGrades(panelGrades, course, generation);

  const parts = [
    { key: "contents", title: "Materials", id: "contents-panel" },
    { key: "assignments", title: "Assignments", id: "assignment-list" },
    { key: "announcements", title: "Announcements", id: "announcement-list" },
  ];
  const load = async (part, target) => {
    target.replaceChildren(node("p", "muted", "Loading..."));
    try {
      const resources = await window.uit.courses[part.key](courseRef(course));
      if (generation !== state.detailGeneration) return;
      target.replaceChildren();
      if (part.key === "contents") {
        state.courseContents = { key: courseKey(course), items: resources };
        renderModules(target, resources, course);
      }
      else {
      if (part.key === "announcements") {
        state.courseAnnouncements = { key: courseKey(course), items: resources };
        if (state.courseContents.key === courseKey(course)) {
          const panel = document.getElementById("contents-panel");
          if (panel) { panel.replaceChildren(); renderModules(panel, state.courseContents.items, course); }
        }
      }
      for (const item of resources) {
        const kind = part.key === "assignments" ? "assignment" : "announcement";
        const resource = resourceFrom(kind, item);
        const block = node("div", "module-block");
        block.append(resourceRow(course, resource));
        for (const file of resource.files) block.append(resourceRow(course, resourceFrom("file", file, resource)));
        target.append(block);
      }
      }
      if (!resources.length) target.append(node("p", "empty", `No ${part.title.toLowerCase()} returned for this course.`));
    } catch (error) {
      if (generation === state.detailGeneration) renderLoadError(target, `${part.title} could not be loaded`, error, () => load(part, target));
    }
  };
  await Promise.all(parts.map((part) => {
    const section = node("section", "resource-section");
    const target = node("div"); target.id = part.id;
    section.append(node("h2", "", part.title), target);
    panelMaterials.append(section);
    return load(part, target);
  }));
}
function resourceFrom(kind, item, module) {
  const attachment = kind === "file" && ["assignment", "announcement"].includes(module?.kind);
  const reference = item.resourceRef;
  return {
    kind, referenceKind: reference?.kind || (attachment ? "file" : kind),
    id: Number(reference?.id ?? (kind === "file" ? (attachment ? module.moduleId ?? module.id : module.id) : item.id)), moduleId: kind === "file" ? (attachment ? module.moduleId ?? module.id : module.id) : item.moduleId,
    name: item.filename || item.name || item.subject || "Untitled resource",
    modname: (kind === "module" ? item : module)?.modname,
    filesize: Number(item.filesize) || undefined,
    fileUrl: item.fileurl, filename: item.filename, mimeType: item.mimetype,
    description: item.description || item.message || "", url: item.url || module?.url,
    files: item.files || [], dueDate: item.dueDate, author: item.author, timestamp: item.timestamp, unavailable: item.unavailable,
  };
}
function renderModules(target, modules, course) {
  // News forums already covered by the Announcements section are not repeated here.
  const covered = state.courseAnnouncements.key === courseKey(course)
    ? new Set(state.courseAnnouncements.items.map((item) => Number(item.moduleId)).filter((id) => Number.isSafeInteger(id) && id > 0))
    : new Set();
  const groups = new Map();
  for (const module of modules) {
    if (module.modname === "forum" && covered.has(Number(module.id))) continue;
    const sectionName = module.section || "Course materials";
    if (!groups.has(sectionName)) {
      const group = node("section", "section-group");
      group.append(node("h3", "section-label", sectionName));
      groups.set(sectionName, group); target.append(group);
    }
    const group = groups.get(sectionName);
    const block = node("div", "module-block");
    block.append(resourceRow(course, resourceFrom("module", module)));
    for (const file of module.files || []) block.append(resourceRow(course, resourceFrom("file", file, module)));
    group.append(block);
  }
}
function forumAnnouncements(course, resource) {
  if (state.courseAnnouncements.key !== courseKey(course)) return null;
  return state.courseAnnouncements.items.filter((item) => Number(item.moduleId) === resource.id);
}
function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
// Mirrors the backend preview allowlist (pdf, docx, markdown, python, images)
// so anything else shows download-only without ever triggering a preview request.
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function resourceExt(resource) {
  return String(resource.filename || resource.name || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
}
function previewMimeType(resource) {
  let mime = String(resource.mimeType || "").split(";")[0].trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") {
    mime = { ".pdf": "application/pdf", ".docx": DOCX_MIME, ".md": "text/markdown", ".markdown": "text/markdown", ".py": "text/x-python", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif" }[resourceExt(resource)] || mime;
  }
  return mime;
}
function previewableFile(resource) {
  const mime = previewMimeType(resource);
  const ext = resourceExt(resource);
  return mime === "application/pdf" || mime === DOCX_MIME || /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(mime) ||
    mime === "text/markdown" || mime === "text/x-markdown" ||
    mime === "text/x-python" || mime === "application/x-python" ||
    (mime === "text/plain" && (ext === ".md" || ext === ".markdown" || ext === ".py" || ext === ".docx"));
}
function resourceMeta(resource, course) {
  if (resource.kind === "assignment") return resource.dueDate ? `Due ${new Date(resource.dueDate * 1000).toLocaleString()}` : "No due date";
  if (resource.kind === "announcement") return [resource.author, resource.timestamp ? new Date(resource.timestamp * 1000).toLocaleDateString() : ""].filter(Boolean).join(" / ");
  if (resource.kind === "file" && !previewableFile(resource)) return humanSize(resource.filesize) || "Download to view";
  if (resource.kind === "module") {
    if (resource.modname === "forum") {
      const items = course ? forumAnnouncements(course, resource) : null;
      if (items) return `${items.length} announcement${items.length === 1 ? "" : "s"}`;
      return "Forum";
    }
    return resource.files.length ? `${resource.files.length} file${resource.files.length === 1 ? "" : "s"}` : "Read activity";
  }
  return "Preview file";
}
function resourceRow(course, resource) {
  const row = node("div", `resource-row${resource.kind === "file" ? " file-row" : ""}`);
  row.dataset.resourceKind = resource.kind; row.dataset.resourceId = resource.id;
  if (resource.fileUrl) row.dataset.fileUrl = resource.fileUrl;
  row.addEventListener("contextmenu", (event) => { event.preventDefault(); openResourceMenu(course, resource); });
  const preview = button("", "resource-open", () => previewResource(course, resource));
  const info = node("span", "resource-info");
  info.append(node("strong", "", resource.name), node("small", "", resourceMeta(resource, course)));
  preview.append(node("span", "resource-type", { module: "MOD", file: "FILE", assignment: "TASK", announcement: "POST" }[resource.kind]), info);
  row.append(preview);
  const overflow = button("...", "icon-button resource-overflow", () => openResourceMenu(course, resource));
  overflow.setAttribute("aria-label", `Actions for ${resource.name}`);
  overflow.setAttribute("aria-haspopup", "dialog");
  row.append(overflow);
  return row;
}
function openResourceMenu(course, resource) {
  state.menuResource = { course, resource };
  $("#resource-menu-title").textContent = resource.name;
  $("#resource-menu-download").hidden = resource.kind !== "file";
  $("#resource-menu-download").disabled = false;
  $("#resource-menu-download").textContent = "Download";
  if (!$("#resource-menu").open) $("#resource-menu").showModal();
  $("#resource-new-thread").focus();
}
function moodleUrl(course, resource) {
  if (resource.url) return resource.url;
  if (resource.kind === "announcement") return `${course.baseUrl}/mod/forum/discuss.php?d=${resource.id}`;
  if (resource.kind === "assignment" && resource.moduleId) return `${course.baseUrl}/mod/assign/view.php?id=${resource.moduleId}`;
  return `${course.baseUrl}/course/view.php?id=${course.id}`;
}
async function openMoodle(course, url) {
  if (!connected(course)) { toast("Reconnect this course's account before opening Moodle."); return; }
  try {
    await window.uit.courses.open({ ...courseRef(course), url });
    const message = "Opened in your browser. Sign in there if Moodle asks.";
    if ($("#resource-reader").open) $("#reader-status").textContent = message;
    else toast(message);
  }
  catch (error) {
    const message = `Could not open Moodle. ${errorText(error)} Reconnect this portal in Course accounts and try again.`;
    if ($("#resource-reader").open) $("#reader-status").textContent = message;
    else toast(message);
  }
}
async function downloadResource(course, resource, control) {
  if (!connected(course)) { toast("Reconnect this course's account before downloading."); return; }
  if (control.disabled) return;
  control.disabled = true;
  const previous = control.textContent;
  control.textContent = "Saving...";
  try {
    const path = await window.uit.courses.materialize({ ...courseRef(course), fileUrl: resource.fileUrl, filename: resource.filename || resource.name, shortname: course.shortname || course.fullname });
    const message = `Saved to ${path}`;
    if (state.reader?.resource === resource) $("#reader-status").textContent = message;
    toast(message);
  } catch (error) {
    const message = `Download failed. ${errorText(error)} Use Download to retry, or reconnect the portal.`;
    if (state.reader?.resource === resource) $("#reader-status").textContent = message;
    toast(message);
  } finally {
    if (control.id !== "reader-download" || state.reader?.resource === resource) { control.disabled = false; control.textContent = previous; }
  }
}
function releasePreview() {
  state.readerGeneration++;
  void state.pdfPreview?.destroy().catch(() => {});
  state.pdfPreview = null;
  $("#reader-body").replaceChildren();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
}
async function previewResource(course, resource) {
  if (!connected(course)) { toast("Reconnect this course's account before previewing."); return; }
  releasePreview();
  state.reader = { course, resource };
  const generation = state.readerGeneration;
  const dialog = $("#resource-reader");
  $("#reader-title").textContent = resource.name;
  $("#reader-kind").textContent = `${resource.kind} / ${course.shortname || course.fullname}`;
  $("#reader-status").textContent = "";
  $("#reader-download").hidden = resource.kind !== "file";
  $("#reader-download").disabled = false;
  $("#reader-download").textContent = "Download";
  if (!dialog.open) dialog.showModal();
  const body = $("#reader-body");
  if (resource.kind === "file" && !previewableFile(resource)) {
    const details = [humanSize(resource.filesize), previewMimeType(resource) || String(resource.filename || "").split(".").pop()].filter(Boolean).join(" / ");
    if (details) body.append(node("p", "muted", details));
    body.append(node("p", "reader-text", `${resource.name} can't be previewed in UIT Studio. Download it or open it in Moodle.`));
    return;
  }
  if (resource.kind !== "file") {
    if (resourceMeta(resource, course)) body.append(node("p", "muted", resourceMeta(resource, course)));
    if (resource.kind === "module" && resource.modname === "forum") {
      const renderForum = (items) => {
        body.replaceChildren();
        if (resourceMeta(resource, course)) body.append(node("p", "muted", resourceMeta(resource, course)));
        for (const item of items) body.append(resourceRow(course, resourceFrom("announcement", item)));
      };
      const cached = forumAnnouncements(course, resource);
      if (cached && cached.length) { renderForum(cached); return; }
      body.append(node("p", "muted", "Loading discussions..."));
      let items = [];
      try {
        let directoryFailed = false;
        try {
          const announcements = await window.uit.courses.announcements(courseRef(course));
          if (generation !== state.readerGeneration || !dialog.open) return;
          state.courseAnnouncements = { key: courseKey(course), items: announcements };
          items = announcements.filter((item) => Number(item.moduleId) === resource.id);
        } catch { directoryFailed = true; /* General forums are read directly below. */ }
        if (!items.length) {
          try {
            items = await window.uit.courses.forum({ ...courseRef(course), moduleId: resource.id });
          } catch (error) {
            // An unreadable forum with a working directory is empty as far as
            // the reader is concerned; only a double failure is an error.
            if (directoryFailed) throw error;
          }
        }
        if (generation !== state.readerGeneration || !dialog.open) return;
        if (items.length) { renderForum(items); return; }
      } catch (error) {
        if (generation !== state.readerGeneration || !dialog.open) return;
        const box = node("div", "load-error"); box.setAttribute("role", "alert");
        box.append(node("p", "", `Announcements could not be loaded. ${errorText(error)}`), button("Retry", "secondary-button", () => previewResource(course, resource)), button("Manage accounts", "text-button", openLogin));
        body.replaceChildren(box);
        return;
      }
      body.replaceChildren();
      if (resourceMeta(resource, course)) body.append(node("p", "muted", resourceMeta(resource, course)));
      body.append(node("p", "muted", "No discussions in this forum yet."));
      for (const file of resource.files) body.append(resourceRow(course, resourceFrom("file", file, resource)));
      return;
    }
    body.append(node("pre", "reader-text", resource.description || "Moodle did not provide readable text for this activity. Open in Moodle to see the full activity."));
    if (resource.unavailable) body.append(node("p", "load-error", Object.values(resource.unavailable).join("\n")));
    for (const file of resource.files) body.append(resourceRow(course, resourceFrom("file", file, resource)));
    if (resource.kind === "assignment" || (resource.kind === "module" && resource.modname === "assign")) {
      const reference = resource.referenceKind === "assignment"
        ? { assignId: resource.id, moduleId: resource.moduleId }
        : { moduleId: resource.kind === "assignment" ? resource.moduleId : resource.id };
      const section = node("div", "submission-block");
      section.append(node("h3", "section-label", "Your submission"), node("p", "muted", "Loading submission..."));
      body.append(section);
      try {
        const submission = await window.uit.courses.submission({ ...courseRef(course), ...reference });
        if (generation !== state.readerGeneration || !dialog.open) return;
        section.replaceChildren(node("h3", "section-label", "Your submission"));
        section.append(node("p", "muted", [`Status: ${submission.status}`, submission.grade ? `Grade: ${submission.grade}` : ""].filter(Boolean).join(" / ")));
        for (const file of submission.files || []) section.append(resourceRow(course, resourceFrom("file", file, resource)));
        if (!(submission.files || []).length) section.append(node("p", "muted", "No submitted files."));
        if (submission.unavailable) section.append(node("p", "load-error", Object.values(submission.unavailable).join("\n")));
      } catch (error) {
        if (generation !== state.readerGeneration || !dialog.open) return;
        section.replaceChildren(node("h3", "section-label", "Your submission"));
        section.append(node("p", "muted", `Submission status unavailable. ${errorText(error)}`));
      }
    }
    return;
  }
  body.append(node("p", "muted", "Loading preview into memory..."));
  try {
    const result = await window.uit.courses.preview({ ...courseRef(course), fileUrl: resource.fileUrl, filename: resource.filename || resource.name });
    if (generation !== state.readerGeneration || !dialog.open) return;
    const mime = String(result.mimeType || "application/octet-stream").split(";")[0].toLowerCase();
    const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
    body.replaceChildren();
    if (mime === "application/pdf" && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
      const { createPdfPreview } = await import("./pdf-preview.js");
      if (generation !== state.readerGeneration || !dialog.open) return;
      const preview = createPdfPreview(body, bytes);
      state.pdfPreview = preview;
      await preview.ready;
      if (generation !== state.readerGeneration || !dialog.open) return;
    } else if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mime)) {
      state.objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const image = node("img"); image.alt = resource.name; image.src = state.objectUrl;
      image.addEventListener("error", () => { if (generation === state.readerGeneration) $("#reader-status").textContent = "This image could not be decoded. Open in Moodle or download the original file."; });
      body.append(image);
    } else if (mime.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(mime)) {
      body.append(node("pre", "", new TextDecoder().decode(bytes)));
    } else {
      body.append(node("p", "reader-text", `Preview is not available for ${mime}. This file has not been saved or opened. Open it in Moodle, or choose Download to save a local copy.`));
    }
  } catch (error) {
    if (generation !== state.readerGeneration || !dialog.open) return;
    const box = node("div", "load-error"); box.setAttribute("role", "alert");
    box.append(node("p", "", `Preview could not be loaded. ${errorText(error)}`), button("Retry preview", "secondary-button", () => previewResource(course, resource)), button("Manage accounts", "text-button", openLogin));
    body.replaceChildren(box);
  }
}

function projectYear(course) {
  const semester = semesterOf(course);
  if (semester.id === "unknown") return "Unknown year";
  const match = `${semester.label} ${semester.id}`.match(/(?:19|20)\d{2}(?:\s*[-\u2013\u2014]\s*(?:19|20)\d{2})?/);
  return match ? match[0].replace(/\s*[-\u2013\u2014]\s*/g, "-") : "Unknown year";
}
// Academic ranges span calendar years, so the filter offers each contained year
// ("2025-2026" matches both 2025 and 2026) while sections keep the range label.
function projectYearOptions(courses) {
  const years = new Set();
  let unknown = false;
  for (const course of courses) {
    const label = projectYear(course);
    if (label === "Unknown year") { unknown = true; continue; }
    const match = label.match(/^((?:19|20)\d{2})(?:-((?:19|20)?\d{2}))?$/);
    if (!match) { years.add(label); continue; }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2].length === 2 ? match[1].slice(0, 2) + match[2] : match[2]) : start;
    for (let year = start; year <= Math.min(end, start + 20); year++) years.add(String(year));
  }
  return [...years].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).concat(unknown ? ["Unknown year"] : []);
}
function projectYearMatches(course, selected) {
  if (selected === "all") return true;
  const label = projectYear(course);
  if (label === "Unknown year") return selected === "Unknown year";
  if (label === selected) return true;
  return projectYearOptions([course]).includes(selected);
}
function openProjectPicker(mode = "thread") {
  if (!state.sessions.length) { openLogin(); return; }
  $("#project-picker").dataset.mode = mode;
  $("#project-picker-title").textContent = mode === "project" ? "New project" : "Choose a project";
  $("#project-search").value = "";
  $("#project-year-field").hidden = mode !== "project";
  const years = projectYearOptions(state.courses.filter((course) => !state.projects.some((project) => courseKey(project) === courseKey(course))));
  const select = $("#project-year");
  select.setAttribute("aria-label", "Academic year");
  select.replaceChildren();
  for (const year of ["all", ...years]) { const option = node("option", "", year === "all" ? "All years" : year); option.value = year; select.append(option); }
  renderProjectOptions();
  if (!$("#project-picker").open) $("#project-picker").showModal();
  $("#project-search").focus();
}
function renderProjectOptions() {
  const target = $("#project-options"); target.replaceChildren();
  const query = $("#project-search").value.trim().toLocaleLowerCase();
  const creating = $("#project-picker").dataset.mode === "project";
  const available = creating ? state.courses.filter((course) => !state.projects.some((project) => courseKey(project) === courseKey(course))) : state.projects.filter(connected);
  const filtered = available.filter((course) => (!creating || $("#project-year").value === "all" || projectYear(course) === $("#project-year").value) && `${course.fullname} ${course.shortname} ${siteLabel(course)} ${semesterOf(course).label}`.toLocaleLowerCase().includes(query));
  const yearSections = new Map();
  for (const group of semesterGroups(filtered)) {
    let section = target;
    if (creating) {
      const year = projectYear(group.courses[0]);
      if (!yearSections.has(year)) {
        const container = node("section", "project-year-group");
        const header = node("header", "project-year-heading");
        const count = filtered.filter((course) => projectYear(course) === year).length;
        header.append(node("h2", "", year), node("span", "", `${count} course${count === 1 ? "" : "s"}`));
        container.append(header); target.append(container); yearSections.set(year, container);
      }
      section = yearSections.get(year);
    }
    section.append(node("h3", "", group.label));
    for (const course of group.courses) {
      const option = button("", "project-option", () => { $("#project-picker").close(); addProject(course); persist(); newThread(course); });
      option.append(node("strong", "", course.fullname), node("small", "", `${course.shortname} / ${siteLabel(course)} / Account ${course.userId}`));
      section.append(option);
    }
  }
  if (!target.childElementCount) target.append(node("p", "empty", creating ? "No available courses" : "No matching projects"));
}
function newThread(course = null, resource = null) {
  if (!state.sessions.length) { openLogin(); return; }
  if (!course) { openProjectPicker(); return; }
  if (course && !connected(course)) { toast("Connect this course's account before starting a thread."); return; }
  addProject(course);
  discardUnsent();
  const owner = course || state.sessions[0];
  const luna = (codexModels || []).find((m) => /luna/i.test(m.id));
  const defaultModel = luna ? luna.id : undefined;
  const defaultEffort = luna && (luna.efforts || []).includes("low") ? "low" : undefined;
  const thread = {
    id: uid(), owner: { baseUrl: owner.baseUrl, userId: owner.userId }, course: course ? courseSnapshot(course) : null,
    title: "New thread", draft: "", resources: resource ? [safeResource(resource)] : [], messages: [], model: defaultModel, effort: defaultEffort,
    threadId: null, turnId: null, cwd: null, started: false, prompted: false, busy: false, pending: false,
    stopping: false, branching: false, interrupted: false, approvals: [], completedTurns: new Set(),
    taskId: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.threads.unshift(thread);
  selectThread(thread.id);
  $("#agent-input").focus();
  return thread;
}
function selectThread(id) {
  discardUnsent(id);
  state.activeId = id;
  persist(); showView("agent");
}
function closeThreadResumeMenu() {
  const menu = $("#thread-resume-menu");
  const btn = $("#thread-resume-btn");
  const cliRow = $("#cli-command-row");
  if (menu) menu.hidden = true;
  if (cliRow) cliRow.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}
async function checkThreadLock(thread = activeThread()) {
  const badge = $("#thread-lock-badge");
  if (!badge) return;
  if (!thread?.threadId) {
    badge.hidden = true;
    if (thread) thread.locked = false;
    $("#view-agent")?.classList.remove("thread-locked");
    return;
  }
  const currentId = thread.id;
  try {
    const { locked } = await window.uit.agent.lockStatus(thread.threadId);
    if (activeThread()?.id !== currentId) return;
    badge.hidden = !locked;
    thread.locked = locked;
    if (locked) {
      $("#view-agent")?.classList.add("thread-locked");
      $("#agent-input").disabled = true;
      $("#send-agent").disabled = true;
      $("#attach-resource").disabled = true;
      $("#agent-input").title = "Thread is locked in an external session (read-only)";
      $("#send-agent").title = "Thread is locked in an external session (read-only)";
      $("#attach-resource").title = "Thread is locked in an external session (read-only)";
      $("#agent-task-title").title = "Thread is locked in an external session (read-only)";
      $("#agent-status").textContent = "Thread is locked in external session (read-only)";
    } else {
      $("#view-agent")?.classList.remove("thread-locked");
      $("#agent-input").title = "";
      $("#send-agent").title = "Send";
      $("#attach-resource").title = "Attach course resource";
      $("#agent-task-title").title = "";
      if (!thread.busy && !thread.archived) {
        $("#agent-input").disabled = false;
        $("#send-agent").disabled = false;
        $("#attach-resource").disabled = false;
        updateThreadStatus();
      }
    }
  } catch {
    badge.hidden = true;
    thread.locked = false;
    $("#view-agent")?.classList.remove("thread-locked");
  }
}
async function syncThreadRollout(thread = activeThread()) {
  if (!thread?.threadId) return;
  const currentId = thread.id;
  try {
    const result = await window.uit.agent.readRollout(thread.threadId);
    if (!result || !result.messages || activeThread()?.id !== currentId) return;
    if (result.mtime && (!thread.lastRolloutMtime || result.mtime > thread.lastRolloutMtime)) {
      thread.lastRolloutMtime = result.mtime;
      let updated = false;
      for (const rm of result.messages) {
        const existing = thread.messages.some((m) => m.text && (m.text === rm.text || rm.text.includes(m.text) || m.text.includes(rm.text)));
        if (!existing && rm.text) {
          thread.messages.push({
            role: rm.role,
            text: rm.text,
            kind: rm.role === "assistant" ? "markdown" : undefined,
            status: "completed",
            label: rm.role === "assistant" ? "Codex (external)" : undefined
          });
          updated = true;
        }
      }
      if (updated) {
        persist();
        if (activeThread()?.id === currentId) {
          renderMessages();
          updateJumpToLatest(thread);
        }
      }
    }
  } catch (err) {
    console.error("Rollout sync error:", err);
  }
}
function renderConversation() {
  const thread = activeThread();
  $("#agent-task-title").textContent = thread?.title || "Codex";
  const actions = $("#thread-actions");
  if (actions) actions.hidden = !thread?.threadId;
  closeThreadResumeMenu();
  $(".composer").hidden = !thread;
  $("#agent-workspace").hidden = !thread?.cwd;
  $("#agent-workspace").textContent = thread?.cwd ? `Workspace: ${thread.cwd}` : "";
  $("#agent-input").value = thread?.draft || "";
  autoResizeInput();
  $("#agent-input").disabled = !thread || Boolean(thread?.archived);
  closeMention(); closeModelMenu();
  renderComposerContext(); renderModelPicker();
  renderChips(); renderMessages(); renderApprovals(); updateThreadStatus();
  checkThreadLock(thread);
}
function autoResizeInput() {
  const input = $("#agent-input");
  if (!input) return;
  input.style.height = "auto";
  const scrollHeight = input.scrollHeight;
  const targetHeight = Math.min(Math.max(scrollHeight, 48), 220);
  input.style.height = `${targetHeight}px`;
  input.style.overflowY = scrollHeight > 220 ? "auto" : "hidden";
}
function renderChips() {
  const thread = activeThread();
  const chips = $("#resource-chips"); chips.replaceChildren();
  for (const [index, resource] of (thread?.resources || []).entries()) {
    const chip = node("span", "resource-chip"); chip.dataset.resourceKind = resource.kind;
    chip.append(node("span", "", `@${resource.name}`));
    const remove = button("x", "", () => { thread.resources.splice(index, 1); persist(); renderChips(); });
    remove.setAttribute("aria-label", `Remove ${resource.name}`);
    chip.append(remove); chips.append(chip);
  }
}
function inlineSvg(inner) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = inner;
  return svg;
}
function renderComposerContext() {
  const thread = activeThread();
  const bar = $("#composer-context");
  bar.replaceChildren();
  if (!thread?.course) { bar.hidden = true; return; }
  bar.hidden = false;
  const project = node("span", "context-pill");
  project.append(inlineSvg('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h5A1.5 1.5 0 0 1 14.5 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z"/>'), node("span", "", thread.course.shortname || thread.course.fullname));
  project.title = thread.course.fullname;
  bar.append(project);
}
let codexModels = null;
let codexModelsFailed = false;
async function ensureModels() {
  if (codexModels || codexModelsFailed) return codexModels;
  try {
    codexModels = await window.uit.codex.models();
  } catch {
    codexModels = [];
    codexModelsFailed = true;
  }
  const luna = (codexModels || []).find((m) => /luna/i.test(m.id));
  if (luna) {
    for (const t of state.threads) {
      if (!t.model) {
        t.model = luna.id;
        if (!t.effort && (luna.efforts || []).includes("low")) t.effort = "low";
      }
    }
    renderModelPicker();
  }
  return codexModels;
}
function modelEntry(thread) {
  return (codexModels || []).find((entry) => entry.id === thread?.model);
}
function effortOptions(thread) {
  const entry = modelEntry(thread);
  if (entry?.efforts?.length) return entry.efforts;
  const all = [];
  for (const model of codexModels || []) for (const effort of model.efforts || []) if (!all.includes(effort)) all.push(effort);
  return all;
}
function modelLabel(thread) {
  if (!thread) return "Auto";
  const entry = modelEntry(thread);
  const name = entry ? entry.displayName : thread.model || "Auto";
  return thread.effort ? `${name} ${thread.effort}` : name;
}
function renderModelPicker() {
  $("#model-picker").textContent = `⚡ ${modelLabel(activeThread())}`;
}
function closeModelMenu() {
  $("#model-menu").hidden = true;
}
function renderModelMenu(menu, thread, models) {
  menu.replaceChildren();
  const pick = (group, label, active, apply) => {
    const item = button("", "model-option", () => { apply(); persist(); renderModelPicker(); closeModelMenu(); $("#agent-input").focus(); });
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", String(active));
    item.append(node("span", "model-name", label[0]), node("span", "model-desc", label[1]), node("span", "model-check", active ? "✓" : ""));
    item.tabIndex = active ? 0 : -1;
    group.append(item);
  };
  menu.append(node("h4", "", "Model"));
  const modelGroup = node("div", "model-options"); modelGroup.setAttribute("role", "radiogroup"); modelGroup.setAttribute("aria-label", "Model");
  for (const option of [{ id: undefined, displayName: "Auto", description: "Codex default" }, ...models]) {
    pick(modelGroup, [option.displayName, option.description || ""], (thread.model || undefined) === option.id, () => {
      thread.model = option.id;
      if (option.id && thread.effort && !(option.efforts || []).includes(thread.effort)) thread.effort = undefined;
    });
  }
  menu.append(modelGroup);
  menu.append(node("h4", "", "Reasoning effort"));
  const effortGroup = node("div", "model-options"); effortGroup.setAttribute("role", "radiogroup"); effortGroup.setAttribute("aria-label", "Reasoning effort");
  for (const effort of [undefined, ...effortOptions(thread)]) {
    pick(effortGroup, [effort || "Auto", ""], (thread.effort || undefined) === effort, () => { thread.effort = effort; });
  }
  menu.append(effortGroup);
}
async function openModelMenu() {
  const thread = activeThread();
  if (!thread) return;
  const menu = $("#model-menu");
  menu.replaceChildren(node("p", "muted", "Loading models..."));
  menu.hidden = false;
  const models = await ensureModels();
  if (thread !== activeThread() || menu.hidden) return;
  if (!models?.length) {
    menu.replaceChildren(node("p", "muted", "Models unavailable. Check the Codex CLI installation."));
    return;
  }
  renderModelMenu(menu, thread, models);
  $(".model-option[aria-checked='true']", menu)?.focus();
}
const mentionCache = new Map();
let mentionState = null;
function mentionOpen() {
  return !$("#mention-list").hidden;
}
function closeMention() {
  $("#mention-list").hidden = true;
  $("#agent-input").setAttribute("aria-expanded", "false");
  $("#agent-input").removeAttribute("aria-activedescendant");
  mentionState = null;
}
async function mentionIndex(course) {
  const key = courseKey(course);
  if (!mentionCache.has(key)) {
    mentionCache.set(key, (async () => {
      const ref = courseRef(course);
      const [contents, assignments, announcements] = await Promise.all([
        window.uit.courses.contents(ref).catch(() => []),
        window.uit.courses.assignments(ref).catch(() => []),
        window.uit.courses.announcements(ref).catch(() => []),
      ]);
      const items = [];
      const seen = new Set();
      const addItem = (kind, name, ref) => {
        if (!name || !Number.isSafeInteger(ref?.id) || ref.id <= 0) return;
        const dedupKey = `${kind}:${ref.id}:${ref.fileUrl || ""}:${name.trim().toLowerCase()}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        items.push({ kind, name: name.trim(), ref });
      };
      const referenceOf = (item, fallback) => item.resourceRef
        ? { kind: item.resourceRef.kind, id: Number(item.resourceRef.id), moduleId: item.resourceRef.moduleId === undefined ? undefined : Number(item.resourceRef.moduleId) }
        : fallback;

      // 1. Assignments and their attached files (high priority for student coursework)
      for (const assignment of assignments) {
        addItem("assignment", assignment.name, referenceOf(assignment, {
          kind: "assignment",
          id: Number(assignment.id),
          moduleId: assignment.moduleId === undefined ? undefined : Number(assignment.moduleId)
        }));
        for (const file of assignment.files || []) {
          const fileId = Number(assignment.moduleId ?? assignment.id);
          addItem("file", file.filename || file.name, {
            kind: "file",
            id: fileId,
            moduleId: assignment.moduleId === undefined ? undefined : Number(assignment.moduleId),
            fileUrl: file.fileurl
          });
        }
      }

      // 2. Announcements and their attached files
      for (const announcement of announcements) {
        addItem("announcement", announcement.subject || announcement.name, referenceOf(announcement, {
          kind: "announcement",
          id: Number(announcement.id),
          moduleId: announcement.moduleId === undefined ? undefined : Number(announcement.moduleId)
        }));
        for (const file of announcement.files || []) {
          const fileId = Number(announcement.moduleId ?? announcement.id);
          addItem("file", file.filename || file.name, {
            kind: "file",
            id: fileId,
            moduleId: announcement.moduleId === undefined ? undefined : Number(announcement.moduleId),
            fileUrl: file.fileurl
          });
        }
      }

      // 3. Materials / Module files (reading materials, slides, code)
      for (const module of contents) {
        for (const file of module.files || []) {
          addItem("file", file.filename || file.name, {
            kind: "file",
            id: Number(module.id),
            fileUrl: file.fileurl
          });
        }
      }

      // 4. Modules: topic sections & activities
      for (const module of contents) {
        addItem("module", module.name, {
          kind: "module",
          id: Number(module.id)
        });
      }

      return items;
    })());
  }
  try {
    return await mentionCache.get(key);
  } catch {
    mentionCache.delete(key);
    return [];
  }
}
async function updateMentions(forceQuery) {
  const thread = activeThread();
  const input = $("#agent-input");
  const box = $("#mention-list");
  if (composerComposing || !thread?.course || document.activeElement !== input) { closeMention(); return; }
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const match = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  const query = forceQuery !== undefined ? forceQuery : (match ? match[2] : null);
  if (query === null) { closeMention(); return; }
  const allItems = await mentionIndex(thread.course);
  const q = query.toLowerCase().trim();
  const filtered = q
    ? allItems.filter((item) => item.name.toLowerCase().includes(q))
    : allItems;
  const items = filtered.slice(0, 15);
  if (composerComposing || thread !== activeThread() || document.activeElement !== input) return;
  if (!items.length) { closeMention(); return; }
  mentionState = { items, active: 0, at: caret - query.length - (match ? 1 : 0), caret };
  box.replaceChildren();
  items.forEach((item, index) => {
    const option = button("", "mention-item", () => selectMention(index));
    option.id = `mention-option-${index}`;
    option.setAttribute("role", "option");
    option.append(node("span", "mention-kind", item.kind), node("span", "mention-name", item.name));
    box.append(option);
  });
  highlightMention();
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");
}
function highlightMention() {
  if (!mentionState) return;
  $$("#mention-list .mention-item").forEach((element, index) => {
    const selected = index === mentionState.active;
    element.setAttribute("aria-selected", String(selected));
    if (selected) element.scrollIntoView({ block: "nearest" });
  });
  $("#agent-input").setAttribute("aria-activedescendant", `mention-option-${mentionState.active}`);
}
function mentionKey(key) {
  if (!mentionState) return;
  if (key === "Escape") { closeMention(); return; }
  if (key === "ArrowDown" || key === "ArrowUp") {
    mentionState.active = (mentionState.active + (key === "ArrowDown" ? 1 : mentionState.items.length - 1)) % mentionState.items.length;
    highlightMention();
    return;
  }
  selectMention(mentionState.active);
}
function selectMention(index) {
  const thread = activeThread();
  const state = mentionState;
  const pick = state?.items[index];
  closeMention();
  if (!thread || !pick) return;
  if (!thread.resources.some((resource) => resource.kind === pick.ref.kind && resource.id === pick.ref.id && (resource.fileUrl || "") === (pick.ref.fileUrl || ""))) {
    thread.resources.push({ ...pick.ref, name: pick.name });
    persist();
    renderChips();
  }
  const input = $("#agent-input");
  input.value = input.value.slice(0, state.at) + input.value.slice(state.caret);
  input.selectionStart = input.selectionEnd = state.at;
  autoResizeInput();
  thread.draft = input.value;
  clearTimeout(draftPersistTimer); draftPersistTimer = setTimeout(persist, 300);
  updateThreadStatus();
  input.focus();
}
function timelineState(thread) {
  if (!thread) return { following: true };
  if (!timelineStates.has(thread.id)) timelineStates.set(thread.id, { following: true });
  return timelineStates.get(thread.id);
}
function timelineAtBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 48; }
function updateJumpToLatest(thread = activeThread()) {
  const control = $("#jump-to-latest");
  const box = $("#agent-messages");
  control.hidden = !thread || timelineState(thread).following || box.scrollHeight <= box.clientHeight;
}
function toolFriendlyWorking(tool, args) {
  if (tool === "uit_list_course_contents") return "Listing course contents...";
  if (tool === "uit_read_resource") return `Reading course resource${args?.name ? `: ${args.name}` : ""}...`;
  if (tool === "uit_download_resource") return "Downloading course material...";
  if (tool === "uit_list_participants") return "Listing course participants...";
  if (tool === "uit_get_grades") return "Reading grade report...";
  return `Running ${tool}...`;
}
function toolFriendlyCompleted(tool, args, failed) {
  if (tool === "uit_list_course_contents") return failed ? "Failed to read course contents" : "Read course contents";
  if (tool === "uit_read_resource") return failed ? `Failed to read ${args?.kind || "resource"}` : `Read ${args?.kind || "resource"}${args?.name ? `: ${args.name}` : ""}`;
  if (tool === "uit_download_resource") return failed ? "Failed to download course file" : "Downloaded course file";
  if (tool === "uit_list_participants") return failed ? "Failed to list participants" : "Listed course participants";
  if (tool === "uit_get_grades") return failed ? "Failed to read grades" : "Read grade report";
  return failed ? `${tool} failed` : `Ran ${tool}`;
}
function formatToolArguments(args) {
  if (!args || (typeof args === "object" && Object.keys(args).length === 0)) return "";
  return typeof args === "string" ? args : JSON.stringify(args, null, 2);
}
function formatToolOutput(item) {
  if (item.contentItems && Array.isArray(item.contentItems)) {
    const texts = item.contentItems.map((c) => c?.text || "").filter(Boolean);
    if (texts.length) {
      try {
        const parsed = JSON.parse(texts.join("\n"));
        return JSON.stringify(parsed, null, 2);
      } catch {
        return texts.join("\n");
      }
    }
  }
  if (item.output) {
    try {
      const parsed = JSON.parse(item.output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(item.output);
    }
  }
  return "(No output)";
}
function unwrapShellCommand(cmd) {
  const s = String(cmd || "").trim();
  const m = /^(?:\/bin\/(?:zsh|bash|sh)|(?:zsh|bash|sh))\s+-(?:l?c)\s+(?:(["'])([\s\S]+)\1|([^\n]+))$/.exec(s);
  return m ? (m[2] || m[3] || s).trim() : s;
}

function cleanToolSummaryLabel(label) {
  if (!label || typeof label !== "string") return label;
  const rx = /^(?:(Ran)\s+)?(?:\/bin\/(?:zsh|bash|sh)|(?:zsh|bash|sh))\s+-(?:l?c)\s+["']?(.*?)["']?(?=\s*(?:failed|·|$))/;
  return label.replace(rx, (m, ran, cmd) => (ran ? "Ran " : "") + cmd.replace(/^["']|["']$/g, "").trim());
}

function createMessageCopyButton(getText) {
  const btn = node("button", "message-copy-btn");
  btn.type = "button";
  btn.title = "Copy message";
  btn.setAttribute("aria-label", "Copy message");

  function copySvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 0 2.5 3.5v5a1.5 1.5 0 0 0 1.5 1.5h2"/>';
    return svg;
  }

  function checkSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<path d="M3.5 8.5l3.5 3.5 6-7"/>';
    return svg;
  }

  btn.append(copySvg());

  let resetTimer = null;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const text = typeof getText === "function" ? getText() : getText;
    if (!text) return;
    try {
      await copyToClipboard(text);
      btn.classList.add("is-copied");
      btn.title = "Copied!";
      btn.setAttribute("aria-label", "Copied to clipboard");
      btn.replaceChildren(checkSvg());
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.classList.remove("is-copied");
        btn.title = "Copy message";
        btn.setAttribute("aria-label", "Copy message");
        btn.replaceChildren(copySvg());
      }, 2000);
    } catch (err) {
      console.error("Failed to copy message:", err);
      toast("Could not copy message.");
    }
  });
  return btn;
}

function renderMessages(changes = null) {
  const thread = activeThread();
  const box = $("#agent-messages");
  const sameThread = box.dataset.threadId === (thread?.id || "");
  const scroll = timelineState(thread);
  if (!sameThread) scroll.following = true;
  const follow = !sameThread || scroll.following;
  const previousScroll = box.scrollTop;
  let inner = changes && $(".messages-inner", box);
  if (!inner) {
    changes = null;
    messageNodes = new WeakMap();
    box.replaceChildren();
    box.dataset.threadId = thread?.id || "";
  }
  if (!thread?.messages.length) {
    $("#jump-to-latest").hidden = true;
    const empty = node("div", "thread-empty");
    if (!thread) empty.append(node("p", "muted", "No thread selected"));
    if (!thread) box.append(empty);
    return;
  }
  if (!inner) { inner = node("div", "messages-inner"); box.append(inner); }
  for (const message of changes || thread.messages) {
    if (message.kind === "reasoning" || message.label === "Thought process") continue;
    const kind = message.kind || (message.role === "event" ? "tool" : message.role);
    const isToolLike = kind === "tool" || kind === "file-change";
    const status = message.status || (isToolLike ? (/failed|error/i.test(message.label || "") ? "failed" : "completed") : undefined);
    const displayLabel = cleanToolSummaryLabel(message.label) || "Activity";
    const cached = messageNodes.get(message);
    if (cached) {
      cached.item.className = `message ${message.role} message-${kind}${status ? ` is-${status}` : ""}${kind === "error" ? " error" : ""}`;
      if (status) cached.item.dataset.status = status;
      if (isToolLike) {
        if (cached.summaryText) cached.summaryText.textContent = displayLabel;
        if (cached.outputPre) {
          const defaultDetail = status === "working" ? "Running..." : "(No output)";
          cached.outputPre.textContent = message.output || (status === "working" ? defaultDetail : message.text || defaultDetail);
          if (status === "failed") cached.outputPre.classList.add("is-failed");
          else cached.outputPre.classList.remove("is-failed");
        }
      } else if (message.role === "assistant") {
        if (!message.streaming) appendRichText(cached.content, message.text);
        else {
          const previous = cached.content.textContent;
          if (cached.content.firstChild?.nodeType === Node.TEXT_NODE && message.text.startsWith(previous)) {
            cached.content.firstChild.appendData(message.text.slice(previous.length));
          } else {
            cached.content.textContent = message.text;
          }
        }
        if (cached.actions) {
          cached.actions.hidden = Boolean(message.streaming) || !message.text;
        }
      } else if (cached.content) {
        cached.content.textContent = message.text;
      }
      continue;
    }
    const item = node("article", `message ${message.role} message-${kind}${status ? ` is-${status}` : ""}${kind === "error" ? " error" : ""}`);
    item.dataset.role = message.role;
    item.dataset.kind = kind;
    if (status) item.dataset.status = status;

    if (isToolLike) {
      const details = node("details", "tool-call");
      if (status === "working") details.open = true;
      const summary = node("summary");
      const dot = node("span", "tool-status-dot");
      const summaryText = node("span", "summary-text", displayLabel);
      const chevron = node("span", "summary-chevron");
      summary.append(dot, summaryText, chevron);

      const body = node("div", "tool-body");
      let inputPre = null;
      let outputPre = null;

      if (kind === "file-change" && message.changes?.length) {
        const section = node("div", "tool-section tool-changes-section");
        section.append(node("div", "tool-section-title", "Changed Files"));
        const list = node("div", "tool-changes-list");
        for (const change of message.changes) {
          const row = node("div", "tool-change-row");
          const changeType = String(change.kind?.type || change.kind || "modified").toLowerCase();
          const tag = node("span", `tool-change-kind is-${changeType}`, `${changeType}: `);
          const path = node("span", "tool-change-path", change.path);
          row.append(tag, path);
          list.append(row);
        }
        section.append(list);
        body.append(section);
      } else {
        let command = message.command;
        let output = message.output;
        if (!command && !message.input && typeof message.text === "string") {
          const m = /^(\/bin\/[a-z]+ -lc "([^"]+)"|^\$ ([^\n]+))\n?([\s\S]*)$/.exec(message.text);
          if (m) {
            command = m[2] || m[3];
            output = output || m[4];
          }
        }
        const hasCommandOrInput = Boolean(command || message.input);
        if (hasCommandOrInput) {
          const displayCommand = command ? unwrapShellCommand(command) : "";
          const inSection = node("div", "tool-section tool-input-section");
          inSection.append(node("div", "tool-section-title", command ? "Command" : "Parameters"));
          inputPre = node("div", "tool-code", command ? `$ ${displayCommand}` : message.input);
          inSection.append(inputPre);
          body.append(inSection);
        }

        const defaultDetail = status === "working" ? "Running..." : "(No output)";
        const outSection = node("div", "tool-section tool-output-section");
        outSection.append(node("div", "tool-section-title", hasCommandOrInput ? "Result" : "Details"));
        const outContent = output || (status === "working" ? defaultDetail : message.text || defaultDetail);
        outputPre = node("pre", `tool-output-content${status === "failed" ? " is-failed" : ""}`, outContent);
        outSection.append(outputPre);
        body.append(outSection);
      }

      details.append(summary, body);
      item.append(details);
      messageNodes.set(message, { item, summaryText, inputPre, outputPre });
    } else if (kind === "turn-state") {
      const copy = node("div", "turn-state-copy");
      copy.append(node("strong", "turn-state-label", message.label || message.text));
      if (message.text && message.text !== message.label) copy.append(node("p", "turn-state-detail", message.text));
      item.append(node("span", "state-marker"), copy);
      messageNodes.set(message, { item });
    } else {
      const isUser = message.role === "user";
      const isAssistant = message.role === "assistant";
      const rich = isAssistant || kind === "error";
      const content = node("pre", rich ? "md" : "");
      if (isAssistant && !message.streaming) appendRichText(content, message.text);
      else content.textContent = message.text;

      let actions = null;
      let copyBtn = null;

      if (isUser) {
        const header = node("div", "message-header");
        header.append(node("p", "message-role", "You"));
        copyBtn = createMessageCopyButton(() => message.text);
        header.append(copyBtn);
        item.append(header, content);
      } else if (isAssistant) {
        item.append(node("p", "message-role", "Codex"), content);
        if (message.resources?.length) item.append(node("p", "message-resources", message.resources.map((resource) => `@${resource.name}`).join("  ")));
        actions = node("div", "message-actions");
        copyBtn = createMessageCopyButton(() => message.text);
        actions.append(copyBtn);
        if (message.streaming || !message.text) actions.hidden = true;
        item.append(actions);
      } else {
        item.append(node("p", "message-role", message.label || "Activity"), content);
      }
      messageNodes.set(message, { item, content, actions, copyBtn });
    }
    if (message.role !== "assistant" && message.resources?.length) {
      item.append(node("p", "message-resources", message.resources.map((resource) => `@${resource.name}`).join("  ")));
    }
    inner.append(item);
  }
  box.scrollTop = follow ? box.scrollHeight : previousScroll;
  updateJumpToLatest(thread);
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Small safe Markdown subset for assistant messages. All source text is HTML-escaped
// before any markup is applied; only tags generated below can reach the DOM.
function renderInline(escaped, codeSpans) {
  let out = escaped.replace(/`([^`\n]+)`/g, (match, code) => { codeSpans.push(code); return `\u0003${codeSpans.length - 1}\u0003`; });
  const links = [];
  // Tokenize markdown links [text](url) first
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (match, label, url) => {
    links.push({ label, url });
    return `\u0004${links.length - 1}\u0004`;
  });
  // Tokenize bare URLs second
  out = out.replace(/(https?:\/\/[^\s<]+)/g, (match, url) => {
    links.push({ label: url, url });
    return `\u0004${links.length - 1}\u0004`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Restore links as safe clickable <a> elements
  out = out.replace(/\u0004(\d+)\u0004/g, (match, index) => {
    const link = links[Number(index)];
    if (!link) return "";
    return `<a class="md-link" href="${link.url}" target="_blank" rel="noopener noreferrer" title="${link.url}">${link.label}</a>`;
  });
  return out.replace(/\u0003(\d+)\u0003/g, (match, index) => `<code>${codeSpans[Number(index)]}</code>`);
}
function renderMarkdownBody(escaped, codeSpans) {
  const lines = escaped.split("\n");
  const html = [];
  let i = 0;
  const TOKEN_LINE = /^(\u0001\d+\u0001|\u0002\d+\u0002)+$/;
  const buildList = (items) => {
    let out = "", index = 0;
    const parse = (baseIndent) => {
      const first = items[index];
      const tag = first.ordered ? "ol" : "ul";
      let chunk = `<${tag}>`;
      while (index < items.length) {
        const item = items[index];
        if (item.indent < baseIndent) break;
        if (item.indent > baseIndent) { chunk += parse(item.indent); continue; }
        index++;
        let inner = renderInline(item.text.replace(/^\[([ xX])\]\s+/, (match, box) => box === " " ? "☐ " : "☒ "), codeSpans);
        if (index < items.length && items[index].indent > baseIndent) inner += parse(items[index].indent);
        chunk += `<li>${inner}</li>`;
      }
      return `${chunk}</${tag}>`;
    };
    out = parse(items[0].indent);
    return out;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (TOKEN_LINE.test(line.trim())) { html.push(line.trim()); i++; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { const level = Math.min(heading[1].length + 1, 4); html.push(`<h${level}>${renderInline(heading[2], codeSpans) || "&nbsp;"}</h${level}>`); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html.push("<hr>"); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${renderInline(quote.join("<br>"), codeSpans)}</blockquote>`);
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const items = [];
      while (i < lines.length) {
        const currentLine = lines[i];
        if (/^\s*$/.test(currentLine)) {
          let nextIdx = i + 1;
          while (nextIdx < lines.length && /^\s*$/.test(lines[nextIdx])) nextIdx++;
          if (nextIdx < lines.length) {
            const nextMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[nextIdx]);
            if (nextMatch) {
              i = nextIdx;
              continue;
            }
          }
          break;
        }
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(currentLine);
        if (match) {
          items.push({ indent: match[1].replace(/\t/g, "  ").length, ordered: /^\d/.test(match[2]), text: match[3] });
          i++;
        } else if (items.length && /^\s+/.test(currentLine)) {
          items[items.length - 1].text += " " + currentLine.trim();
          i++;
        } else {
          break;
        }
      }
      html.push(buildList(items));
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^[\s|:|-]+$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => renderInline(cell.trim(), codeSpans));
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      html.push(`<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>${body.length ? `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>` : ""}</table>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !TOKEN_LINE.test(lines[i].trim()) && !/^(#{1,4}\s|>\s?|(\s*([-*+]|\d+[.)])\s+))/.test(lines[i])) { paragraph.push(lines[i++]); }
    if (!paragraph.length) paragraph.push(lines[i++]);
    html.push(`<p>${paragraph.map((chunk) => renderInline(chunk, codeSpans)).join("<br>")}</p>`);
  }
  return html.join("");
}
function appendRichText(container, text) {
  // Codex file citations render as links that open the downloaded workspace file.
  const citations = [];
  const source = String(text).replace(/(?:Nguồn:\s*)?:codex-file-citation\{([^}]*)\}/g, (match, attrs) => {
    const path = /path="((?:[^"\\]|\\.)*)"/.exec(attrs)?.[1]?.replace(/\\(.)/g, "$1") || "";
    const name = path.split("/").pop() || "";
    if (!path || !name) return match;
    citations.push({ path, name });
    return `\u0001${citations.length - 1}\u0001`;
  });
  const codeSpans = [];
  const blocks = [];
  // Extract fences before escaping so code keeps its raw characters.
  const defenced = source.replace(/^```(\w*)\n([\s\S]*?)^```[ \t]*$/gm, (match, lang, code) => {
    blocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
    return `\u0002${blocks.length - 1}\u0002`;
  });
  const escaped = escapeHtml(defenced);
  const mountTokens = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const textNode of nodes) {
      const parts = textNode.data.split(/(\u0001\d+\u0001|\u0002\d+\u0002)/g);
      if (parts.length < 2) continue;
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        const citation = /^\u0001(\d+)\u0001$/.exec(part);
        const block = /^\u0002(\d+)\u0002$/.exec(part);
        if (citation && citations[Number(citation[1])]) {
          const { path, name } = citations[Number(citation[1])];
          const link = button(name, "citation-link", () => {
            window.uit.shell.open(path).then((error) => { if (error) toast(`Could not open attachment. ${errorText(error)}`); }, (error) => toast(`Could not open attachment. ${errorText(error)}`));
          });
          link.title = path;
          fragment.append(link);
        } else if (block && blocks[Number(block[1])]) {
          const { lang, code } = blocks[Number(block[1])];
          const pre = document.createElement("pre");
          pre.className = "md-code";
          if (lang) pre.dataset.language = lang;
          pre.textContent = code;
          fragment.append(pre);
        } else fragment.append(document.createTextNode(part));
      }
      textNode.replaceWith(fragment);
    }
  };
  container.replaceChildren();
  if (!escaped) return;
  const template = document.createElement("template");
  template.innerHTML = renderMarkdownBody(escaped, codeSpans);
  mountTokens(template.content);
  container.append(...template.content.childNodes);
}
function flushStreamUpdates() {
  if (streamFrame !== null) cancelAnimationFrame(streamFrame);
  streamFrame = null;
  const changes = streamUpdates.get(activeThread());
  if (state.view === "agent" && changes) { renderMessages(changes); updateThreadStatus(); }
  streamUpdates.clear();
}
function updateThreadStatus() {
  const thread = activeThread();
  $("#send-agent").disabled = !thread || !thread.course || thread.busy || thread.pending || thread.branching || thread.archived || !thread.draft.trim();
  $("#send-agent").hidden = Boolean(thread?.busy);
  $("#model-picker").disabled = !thread;
  $("#attach-resource").disabled = !thread?.course;
  $("#stop-agent").hidden = !thread?.busy;
  $("#stop-agent").disabled = !thread?.threadId || !thread?.turnId || thread.stopping;
  $("#stop-agent").setAttribute("aria-label", thread?.stopping ? "Stopping" : "Stop");
  $("#stop-agent").title = thread?.stopping ? "Stopping" : "Stop";
  $("#agent-messages").setAttribute("aria-busy", String(Boolean(thread?.busy || thread?.pending)));
  $("#agent-status").textContent = thread?.archived ? "Archived / Restore to continue" : thread?.branching ? "Branching thread..." : thread?.busy ? thread.approvals.length ? "Waiting for approval" : "Codex is working..." : thread?.pending ? "Finishing request..." : thread?.interrupted ? "Connection interrupted. Review the last turn before sending again." : "Ready";
}
function resourcePayload(resources) {
  return resources.map(({ kind, id, moduleId, fileUrl }) => ({ kind, id, ...(moduleId ? { moduleId } : {}), ...(fileUrl ? { fileUrl } : {}) }));
}
async function sendMessage() {
  const thread = activeThread();
  if (composerComposing || !thread || thread.busy || thread.pending || thread.branching || !thread.draft.trim()) return;
  if (!thread.course || !connected(thread.course)) { toast("Choose a connected course before sending."); return; }
  const text = thread.draft.trim();
  const resources = thread.resources.map(safeResource);
  const taskId = uid();
  thread.taskId = taskId; thread.turnId = null; thread.busy = true; thread.pending = true; thread.stopping = false; thread.approvals = [];
  thread.started = true; thread.prompted = true; thread.interrupted = false; thread.streamItem = null;
  thread.draft = ""; thread.resources = [];
  thread.messages.push({ role: "user", text, resources });
  thread.messages.push({ role: "event", kind: "turn-state", status: "working", label: "Codex is working", text: "Codex is working", taskId });
  timelineState(thread).following = true;
  if (!thread.renamed && thread.title === "New thread") thread.title = text.slice(0, 70);
  persist(); renderRail(); renderConversation();
  try {
    const effectiveModel = thread.model || (codexModels || []).find((m) => /luna/i.test(m.id))?.id;
    const effectiveEffort = thread.effort || (effectiveModel && /luna/i.test(effectiveModel) ? "low" : undefined);
    const payload = { ...courseRef(thread.course), shortname: thread.course.shortname || thread.course.fullname, taskId, resources: resourcePayload(resources), message: text, ...(effectiveModel ? { model: effectiveModel } : {}), ...(effectiveEffort ? { effort: effectiveEffort } : {}) };
    if (thread.forkSource && !thread.threadId) {
      const branch = await window.uit.agent.fork({ threadId: thread.forkSource });
      thread.threadId = branch.id;
      delete thread.forkSource;
    }
    const result = !thread.threadId
      ? await window.uit.agent.start({ ...payload, context: thread.course.fullname })
      : await window.uit.agent.send({ ...payload, threadId: thread.threadId, cwd: thread.cwd });
    if (thread.taskId !== taskId) return;
    thread.threadId = result.threadId || thread.threadId;
    if (result.model && !thread.model) thread.model = result.model;
    thread.turnId = result.turnId || result.id || thread.turnId;
    thread.cwd = result.workspace || thread.cwd;
    // A completion notification may arrive before the invoke response.
    if (thread.completedTurns.has(thread.turnId) || ["completed", "interrupted", "failed"].includes(result.status)) thread.busy = false;
  } catch (error) {
    if (thread.taskId !== taskId) return;
    thread.busy = false; thread.interrupted = true; thread.approvals = [];
    const working = thread.messages.find((message) => message.kind === "turn-state" && message.taskId === taskId);
    if (working) Object.assign(working, { kind: "error", status: "failed", label: "Could not send", text: `${errorText(error)} Check Codex installation/authentication and the connected course account, then send again.` });
    if (!thread.draft) { thread.draft = text; thread.resources = resources; }
  } finally {
    if (thread.taskId === taskId) thread.pending = false;
    thread.updatedAt = Date.now(); persist(); renderRail();
    if (thread.id === state.activeId && state.view === "agent") renderConversation();
  }
}
async function stopThread() {
  const thread = activeThread();
  if (!thread?.busy || !thread.threadId || !thread.turnId || thread.stopping) return;
  const taskId = thread.taskId;
  thread.stopping = true; updateThreadStatus();
  try { await window.uit.agent.stop({ threadId: thread.threadId, turnId: thread.turnId }); }
  catch (error) { toast(`Could not stop this turn. ${errorText(error)} Try Stop again.`); }
  finally { if (thread.taskId === taskId) thread.stopping = false; if (thread.id === state.activeId) updateThreadStatus(); }
}
async function branchThread(targetThread) {
  const source = targetThread || activeThread();
  if (!source?.threadId || source.busy || source.pending || source.branching) return;
  source.branching = true;
  if (source.id === state.activeId && state.view === "agent") renderConversation();
  try {
    const branch = newThread(source.course);
    if (!branch) return;
    branch.title = `Branch: ${source.title}`; branch.renamed = true;
    branch.forkSource = source.threadId; branch.cwd = source.cwd; branch.started = false;
    branch.turnId = source.turnId;
    branch.messages = structuredClone(source.messages); branch.draft = source.draft;
    branch.resources = structuredClone(source.resources);
    persist(); renderRail(); renderConversation();
  } catch (error) { toast(`Could not branch this thread. ${errorText(error)} Try Branch again.`); }
  finally { source.branching = false; if (state.view === "agent") renderConversation(); }
}
function renderApprovals() {
  const thread = activeThread();
  const target = $("#agent-approvals"); target.replaceChildren();
  for (const approval of thread?.approvals || []) {
    const box = node("section", "approval"); box.dataset.requestId = String(approval.requestId);
    box.append(node("h3", "", "Allow this action?"), node("pre", "", approval.command));
    const decide = async (approved) => {
      if (approval.pending) return;
      approval.pending = true;
      $$("button", box).forEach((control) => { control.disabled = true; });
      try {
        await window.uit.agent.approve({ requestId: approval.requestId, approved });
        thread.approvals = thread.approvals.filter((item) => item !== approval);
        thread.messages.push({ role: "event", kind: "approval", status: approved ? "completed" : "stopped", label: approved ? "Action approved" : "Action denied", text: approval.command });
        persist(); if (thread.id === state.activeId) { renderApprovals(); renderMessages(); updateThreadStatus(); }
      } catch (error) {
        approval.pending = false;
        approval.error = `Approval failed. ${errorText(error)} Retry your decision.`;
        if (thread.id === state.activeId) renderApprovals();
      }
    };
    box.append(button("Deny", "secondary-button", () => decide(false)), button("Allow", "primary-button", () => decide(true)));
    if (approval.error) box.append(node("p", "form-error", approval.error));
    $$("button", box).forEach((control) => { control.disabled = !!approval.pending; });
    target.append(box);
  }
}
function handleAgentEvent(message) {
  if (!message || typeof message.method !== "string") return;
  const params = message.params || {};
  const threadId = params.threadId || params.thread?.id;
  const turnId = params.turnId || params.turn?.id;
  if (message.method === "thread/deleted" && threadId) {
    const removed = state.threads.filter((thread) => thread.threadId === threadId);
    if (!removed.length) return;
    for (const thread of removed) { removeLocalThread(thread); timelineStates.delete(thread.id); }
    persist(); renderRail();
    if (state.view === "agent") renderConversation();
    return;
  }
  if (message.method === "thread/name/updated" && threadId) {
    const renamed = state.threads.filter((thread) => thread.threadId === threadId);
    if (!renamed.length) return;
    const newName = params.threadName || params.name;
    if (newName) {
      for (const item of renamed) { item.title = newName; item.renamed = true; }
      persist(); renderRail();
      if (state.view === "agent") renderConversation();
    }
    return;
  }
  // Never fall back to the selected thread. taskId exists before start resolves.
  const thread = params.taskId
    ? state.threads.find((item) => item.taskId === params.taskId)
    : state.threads.find((item) => item.threadId && item.threadId === threadId);
  if (!thread) {
    if (message.method === "codex/exit" && !params.taskId && !threadId) {
      flushStreamUpdates();
      for (const item of state.threads.filter((entry) => entry.busy)) {
        item.busy = false; item.interrupted = true; item.approvals = [];
        item.messages.push({ role: "event", kind: "error", label: "Codex disconnected", text: "The connection closed. Review the last turn, then send again to reconnect." });
      }
      persist(); renderRail(); if (state.view === "agent") renderConversation();
    }
    return;
  }
  if (threadId && thread.threadId && thread.threadId !== threadId) return;
  if (turnId && thread.turnId && thread.turnId !== turnId) return;
  if (turnId && thread.completedTurns.has(turnId)) return;
  if (threadId) thread.threadId = threadId;
  if (turnId) thread.turnId = turnId;
  const item = params.item || {};
  const itemId = params.itemId || item.id;
  let deltaEntry = null;
  const eventMessage = (role, label, kind, status) => {
    let entry = itemId ? thread.messages.find((entry) => entry.itemId === itemId && entry.turnId === thread.turnId) : null;
    if (!entry && role === "assistant" && thread.streamItem && (!itemId || !thread.streamItem.itemId || thread.streamItem.itemId === itemId)) entry = thread.streamItem;
    if (!entry) {
      entry = { role, label, text: "", itemId, turnId: thread.turnId, kind, status };
      thread.messages.push(entry);
    }
    if (label) entry.label = label;
    if (kind) entry.kind = kind;
    if (status) entry.status = status;
    return entry;
  };
  const turnState = () => thread.messages.find((entry) => entry.kind === "turn-state" && ((turnId && entry.turnId === turnId) || (params.taskId && entry.taskId === params.taskId)));
  const commandSummary = (command) => {
    const raw = String(command || "workspace command").trim();
    const unwrapped = unwrapShellCommand(raw);
    return (unwrapped || raw).split("\n")[0].trim().slice(0, 100);
  };
  switch (message.method) {
    case "thread/started":
    case "turn/started":
      if (turnState() && turnId) turnState().turnId = turnId;
      break;
    case "agent/approval":
      if (!thread.approvals.some((approval) => approval.requestId === params.requestId)) thread.approvals.push({ requestId: params.requestId, command: String(params.command || params.reason || "No action details were provided. Deny if you cannot verify the request.") });
      break;
    case "item/agentMessage/delta": {
      const entry = eventMessage("assistant", "Codex");
      entry.streaming = true; entry.text += String(params.delta || ""); thread.streamItem = entry; deltaEntry = entry; break;
    }
    case "item/commandExecution/outputDelta": {
      const entry = eventMessage("event", "Running command", "tool", "working");
      entry.output = (entry.output || "") + String(params.delta || "");
      entry.text = [entry.command, entry.output].filter(Boolean).join("\n");
      deltaEntry = entry;
      break;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const stateEntry = turnState();
      if (stateEntry && stateEntry.status === "working") {
        stateEntry.label = "Thinking...";
        stateEntry.text = "Thinking...";
        deltaEntry = stateEntry;
      }
      break;
    }
    case "item/started": {
      if (item.type === "commandExecution") {
        const entry = eventMessage("event", `Running ${commandSummary(item.command)}`, "tool", "working");
        entry.command = item.command;
        entry.output = "";
        entry.text = item.command || "Running workspace command...";
      } else if (item.type === "dynamicToolCall") {
        const toolName = item.tool || "uit_tool";
        const entry = eventMessage("event", toolFriendlyWorking(toolName, item.arguments), "tool", "working");
        entry.toolName = toolName;
        entry.command = toolName;
        entry.input = formatToolArguments(item.arguments);
        entry.output = "";
        entry.text = entry.input || toolName;
      } else if (item.type === "mcpToolCall") {
        const entry = eventMessage("event", `Calling ${item.server}.${item.tool}...`, "tool", "working");
        entry.toolName = `${item.server}.${item.tool}`;
        entry.command = entry.toolName;
        entry.input = formatToolArguments(item.arguments);
        entry.output = "";
        entry.text = entry.input || entry.toolName;
      } else if (item.type === "fileChange") {
        const entry = eventMessage("event", "Applying file changes...", "file-change", "working");
        entry.changes = item.changes || [];
      } else if (item.type === "reasoning") {
        const stateEntry = turnState();
        if (stateEntry && stateEntry.status === "working") {
          stateEntry.label = "Thinking...";
          stateEntry.text = "Thinking...";
          deltaEntry = stateEntry;
        }
      }
      break;
    }
    case "item/completed": {
      if (item.type === "agentMessage") {
        const entry = eventMessage("assistant", "Codex");
        entry.text = String(item.text || thread.streamItem?.text || ""); entry.streaming = false;
        thread.streamItem = null;
      } else if (item.type === "commandExecution") {
        const failed = Number.isFinite(item.exitCode) && item.exitCode !== 0;
        const entry = eventMessage("event", "Command completed", "tool", failed ? "failed" : "completed");
        entry.command = item.command || entry.command;
        entry.exitCode = item.exitCode;
        entry.durationMs = item.durationMs;
        const output = item.aggregatedOutput || item.output || entry.output || "";
        entry.output = output;
        const dur = item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "";
        entry.label = failed
          ? `${commandSummary(entry.command)} failed · exit ${item.exitCode}${dur}`
          : `Ran ${commandSummary(entry.command)}${item.exitCode == null ? "" : ` · exit ${item.exitCode}`}${dur}`;
        entry.text = [entry.command, entry.output].filter(Boolean).join("\n");
      } else if (item.type === "dynamicToolCall") {
        const failed = item.success === false;
        const toolName = item.tool || "tool";
        const entry = eventMessage("event", "Tool completed", "tool", failed ? "failed" : "completed");
        entry.toolName = toolName;
        entry.command = toolName;
        entry.input = formatToolArguments(item.arguments) || entry.input;
        entry.durationMs = item.durationMs;
        const dur = item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "";
        entry.label = `${toolFriendlyCompleted(toolName, item.arguments, failed)}${dur}`;
        entry.output = formatToolOutput(item);
        entry.text = [entry.input, entry.output].filter(Boolean).join("\n");
      } else if (item.type === "mcpToolCall") {
        const failed = item.status === "failed" || Boolean(item.error);
        const entry = eventMessage("event", "MCP Tool completed", "tool", failed ? "failed" : "completed");
        entry.toolName = `${item.server}.${item.tool}`;
        entry.command = entry.toolName;
        entry.durationMs = item.durationMs;
        const dur = item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "";
        entry.label = `${failed ? "Failed" : "Ran"} ${entry.toolName}${dur}`;
        entry.output = item.error ? String(item.error.message || item.error) : JSON.stringify(item.result, null, 2);
        entry.text = [entry.input, entry.output].filter(Boolean).join("\n");
      } else if (item.type === "fileChange") {
        const changes = item.changes || [];
        const entry = eventMessage("event", `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}`, "file-change", "completed");
        entry.changes = changes;
        entry.text = changes.map((change) => `${change.kind?.type || change.kind || "Changed"}: ${change.path}`).join("\n");
      } else if (item.type === "reasoning") {
        // Omit reasoning items from message history
        break;
      }
      break;
    }
    case "turn/completed":
      if (turnId) thread.completedTurns.add(turnId);
      thread.busy = false; thread.stopping = false; thread.streamItem = null; thread.approvals = [];
      if (params.turn?.error || params.turn?.status === "failed") {
        const entry = turnState();
        const text = params.turn?.error ? `${errorText(params.turn.error)} Review the error and send again to retry.` : "The turn failed before Codex returned an answer. Send again to retry.";
        if (entry) Object.assign(entry, { kind: "error", status: "failed", label: "Turn failed", text });
        else thread.messages.push({ role: "event", kind: "error", status: "failed", label: "Turn failed", text });
      } else if (params.turn?.status === "interrupted") {
        const entry = turnState();
        if (entry) Object.assign(entry, { status: "stopped", label: "Stopped", text: "This turn was stopped. Send a message to continue." });
        else thread.messages.push({ role: "event", kind: "turn-state", status: "stopped", label: "Stopped", text: "This turn was stopped. Send a message to continue." });
      } else {
        const entry = turnState();
        if (entry) thread.messages.splice(thread.messages.indexOf(entry), 1);
      }
      break;
    case "error":
    case "agent/error":
      thread.messages.push({ role: "event", kind: "error", label: "Codex error", text: `${errorText(params.error || params.message)} Review the error before retrying.` });
      if (!params.willRetry) { thread.busy = false; thread.interrupted = true; thread.approvals = []; }
      break;
    case "codex/exit":
      thread.busy = false; thread.interrupted = true; thread.approvals = [];
      thread.messages.push({ role: "event", kind: "error", label: "Codex disconnected", text: "The connection closed. Send again to reconnect." });
      break;
    default: return;
  }
  thread.updatedAt = Date.now();
  if (deltaEntry) {
    // State is current immediately; background threads need no rendering work.
    if (state.view === "agent" && thread === activeThread()) {
      if (!streamUpdates.has(thread)) streamUpdates.set(thread, new Set());
      streamUpdates.get(thread).add(deltaEntry);
      if (streamFrame === null) streamFrame = requestAnimationFrame(flushStreamUpdates);
    }
    if (streamPersistTimer === null) streamPersistTimer = setTimeout(persist, 1000);
    return;
  }
  flushStreamUpdates(); persist(); renderRail();
  if (thread.id === state.activeId && state.view === "agent") {
    renderMessages();
    if (["agent/approval", "turn/completed", "error", "agent/error", "codex/exit"].includes(message.method)) renderApprovals();
    updateThreadStatus();
  }
}

function applySessions(result) {
  state.sessions = Array.isArray(result.sessions) ? result.sessions.map(({ baseUrl, userId, authMode, label }) => ({ baseUrl, userId, authMode, label })) : [];
  state.loginFormOpen = false;
  state.listGeneration++; state.detailGeneration++;
  state.courses = state.courses.filter(connected);
  if (!activeThread()) state.activeId = null;
  if (state.reader && !connected(state.reader.course)) $("#resource-reader").close();
  if (state.menuResource && !connected(state.menuResource.course)) { $("#resource-menu").close(); state.menuResource = null; }
  if ($("#rename-dialog").open && !state.threads.some((thread) => thread.id === $("#rename-dialog").dataset.taskId && visibleThread(thread))) $("#rename-dialog").close();
  if (state.selectedCourse && !connected(state.selectedCourse)) { state.selectedCourse = null; showView("courses"); }
  $("#account-label").textContent = state.sessions.length ? `Course accounts (${state.sessions.length})` : "Connect accounts";
  if ($("#project-picker").open) renderProjectOptions();
  renderSessions(); renderRail(); renderCourseList();
  if (state.view === "agent") renderConversation();
}
function renderDiscovery(status) {
  const lines = (status.courseDiscovery || []).map((entry) => {
    const report = entry.diagnostics;
    return `${siteLabel(entry)} / Account ${entry.userId}\n${report ? `Checked: ${report.checkedAt || "Not yet"}\nDiscovered: ${report.total}\n${report.sources.map((source) => `${source.source}: ${source.status}; ${source.count || 0} courses; ${source.pages || 0} pages${source.message ? `; ${source.message}` : ""}`).join("\n")}` : "This portal uses the enrolment REST list; no session-AJAX diagnostics."}`;
  });
  $("#discovery-report").textContent = lines.join("\n\n") || "Refresh courses to collect source counts.";
}
function portalKind(baseUrl) { return String(baseUrl || "").endsWith("/sdh") ? "Graduate" : "Undergraduate"; }
function renderSessions() {
  const currentSession = state.sessions.find((session) => session.baseUrl === CURRENT_SITE);
  const ssoSection = $("#sso-section");
  const ssoPill = $("#sso-pill");
  const ssoLogin = $("#sso-login");
  const ssoDisconnect = $("#sso-disconnect");
  const ssoStatus = $("#sso-status");

  if (currentSession) {
    ssoSection.classList.add("session-row");
    ssoSection.dataset.baseUrl = currentSession.baseUrl;
    ssoPill.className = "status-pill connected";
    ssoPill.textContent = "Connected";
    ssoStatus.textContent = `Account ${currentSession.userId}`;
    ssoLogin.textContent = "Re-login with UIT SSO";
    ssoLogin.className = "secondary-button";
    ssoLogin.disabled = state.authBusy;
    ssoDisconnect.hidden = false;
    ssoDisconnect.disabled = state.authBusy;
  } else {
    ssoSection.classList.remove("session-row");
    delete ssoSection.dataset.baseUrl;
    ssoPill.className = "status-pill disconnected";
    ssoPill.textContent = "Not connected";
    ssoStatus.textContent = "";
    ssoLogin.textContent = "Continue with UIT SSO";
    ssoLogin.className = "primary-button";
    ssoLogin.disabled = state.authBusy;
    ssoDisconnect.hidden = true;
  }

  const legacySessions = state.sessions.filter((session) => session.baseUrl !== CURRENT_SITE);
  const legacySection = $("#legacy-section");
  const legacyPill = $("#legacy-pill");
  const legacyRelogin = $("#legacy-relogin");
  const legacyDisconnect = $("#legacy-disconnect");
  const legacyStatus = $("#legacy-status");
  const loginForm = $("#login-form");

  if (legacySessions.length) {
    legacySection.classList.add("session-row");
    legacySection.dataset.baseUrl = legacySessions[0].baseUrl;
    legacyPill.className = "status-pill connected";
    legacyPill.textContent = "Connected";
    legacyStatus.textContent = legacySessions.map((session) => `${portalKind(session.baseUrl)} · Account ${session.userId}`).join(", ");
    legacyRelogin.hidden = state.loginFormOpen;
    legacyRelogin.disabled = state.authBusy;
    legacyDisconnect.hidden = false;
    legacyDisconnect.disabled = state.authBusy;
    loginForm.hidden = !state.loginFormOpen;
  } else {
    legacySection.classList.remove("session-row");
    delete legacySection.dataset.baseUrl;
    legacyPill.className = "status-pill disconnected";
    legacyPill.textContent = "Not connected";
    legacyStatus.textContent = "";
    legacyRelogin.hidden = true;
    legacyDisconnect.hidden = true;
    loginForm.hidden = false;
  }

  $("#logout-button").disabled = state.authBusy || !state.sessions.length;
  $$("input, select, button", loginForm).forEach((control) => { control.disabled = state.authBusy; });
}
function openLogin() {
  state.loginFormOpen = false;
  $("#login-error").textContent = ""; $("#login-status").textContent = "";
  renderSessions();
  if (!$("#login-modal").open) $("#login-modal").showModal();
  window.uit.session.status().then(renderDiscovery).catch(() => { $("#discovery-report").textContent = "Could not read discovery diagnostics."; });
}
async function authAction(action, success) {
  if (state.authBusy) return;
  state.authBusy = true; renderSessions();
  $("#login-error").textContent = ""; $("#login-status").textContent = "Connecting to UIT...";
  try {
    const previous = new Set(state.sessions.map(identity));
    const result = await action();
    if (result.sessions?.some((session) => !previous.has(identity(session)))) state.semester = null;
    applySessions(result);
    state.loginFormOpen = false;
    $("#login-status").textContent = success;
    if (state.sessions.length) {
      await loadCourses();
      if (state.view === "course" && state.selectedCourse) await openCourse(state.selectedCourse);
    }
    else { state.semester = null; $("#semester-select").replaceChildren(); $("#semester-select").disabled = true; $("#refresh-courses").disabled = false; }
  } catch (error) {
    $("#login-status").textContent = "";
    $("#login-error").textContent = `${errorText(error)} Check your account and connection, then try again.`;
  } finally { state.authBusy = false; renderSessions(); }
}

$$(".nav-item[data-view]").forEach((control) => control.addEventListener("click", () => showView(control.dataset.view)));
$("#new-project").addEventListener("click", () => openProjectPicker("project"));
$("#close-project-picker").addEventListener("click", () => $("#project-picker").close());
$("#project-search").addEventListener("input", renderProjectOptions);
$("#project-year").addEventListener("change", renderProjectOptions);
$("#back-courses").addEventListener("click", () => showView("courses"));
$("#refresh-courses").addEventListener("click", () => state.sessions.length ? loadCourses(true) : openLogin());
$("#course-search").addEventListener("input", renderCourseList);
$("#semester-select").addEventListener("change", (event) => { state.semester = event.currentTarget.value; renderCourseList(); });

$("#agent-input").addEventListener("input", (event) => {
  autoResizeInput();
  const thread = activeThread();
  if (thread) {
    thread.draft = event.currentTarget.value;
    clearTimeout(draftPersistTimer); draftPersistTimer = setTimeout(persist, 300);
    updateThreadStatus();
    if (!composerComposing) updateMentions();
  }
});
$("#agent-input").addEventListener("compositionstart", () => { composerComposing = true; closeMention(); });
$("#agent-input").addEventListener("compositionend", (event) => {
  composerComposing = false;
  autoResizeInput();
  const thread = activeThread();
  if (thread) { thread.draft = event.currentTarget.value; updateThreadStatus(); updateMentions(); }
});
$("#agent-input").addEventListener("keydown", (event) => {
  if (composerComposing || event.isComposing || event.keyCode === 229) return;
  if (mentionOpen() && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) { event.preventDefault(); mentionKey(event.key); return; }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    if (!$("#model-menu").hidden) { event.preventDefault(); closeModelMenu(); return; }
    event.preventDefault(); $("#agent-form").requestSubmit();
  }
  if (event.key === "Escape" && !$("#model-menu").hidden) { event.preventDefault(); closeModelMenu(); }
});
$("#agent-messages").addEventListener("scroll", (event) => {
  const thread = activeThread();
  if (!thread || event.currentTarget.dataset.threadId !== thread.id) return;
  timelineState(thread).following = timelineAtBottom(event.currentTarget);
  updateJumpToLatest(thread);
}, { passive: true });
$("#jump-to-latest").addEventListener("click", () => {
  const thread = activeThread();
  if (!thread) return;
  timelineState(thread).following = true;
  $("#agent-messages").scrollTo({ top: $("#agent-messages").scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  updateJumpToLatest(thread);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (mentionOpen()) { closeMention(); return; }
  if (!$("#model-menu").hidden) closeModelMenu();
  closeThreadResumeMenu();
  closeRailMenu();
});
document.addEventListener("click", (event) => {
  if (railMenu && !event.target.closest(".rail-menu") && !event.target.closest("[data-rail-menu]")) closeRailMenu();
  if (!$("#thread-resume-menu")?.hidden && !event.target.closest("#thread-resume-wrap")) closeThreadResumeMenu();
});
async function copyToClipboard(text) {
  if (window.uit?.agent?.writeClipboard) {
    try {
      const res = await window.uit.agent.writeClipboard(text);
      if (res?.success) return true;
    } catch (_) {}
  }
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const success = document.execCommand("copy");
    document.body.removeChild(ta);
    if (success) return true;
  } catch (_) {
    document.body.removeChild(ta);
  }
  throw new Error("Failed to copy text to clipboard.");
}
$("#thread-resume-btn")?.addEventListener("click", () => {
  const menu = $("#thread-resume-menu");
  if (!menu) return;
  menu.hidden = !menu.hidden;
  $("#thread-resume-btn")?.setAttribute("aria-expanded", String(!menu.hidden));
  if (menu.hidden) {
    const cliRow = $("#cli-command-row");
    if (cliRow) cliRow.hidden = true;
  }
});
$("#resume-codex-cli")?.addEventListener("click", () => {
  const thread = activeThread();
  if (!thread?.threadId) {
    toast("No active Codex thread to resume.");
    return;
  }
  const row = $("#cli-command-row");
  const textEl = $("#cli-cmd-text");
  if (!row || !textEl) return;
  const cmd = `codex resume ${thread.threadId}`;
  textEl.textContent = cmd;
  textEl.setAttribute("title", cmd);
  row.hidden = !row.hidden;
});
async function handleCopyCliCommand() {
  const thread = activeThread();
  if (!thread?.threadId) {
    toast("No active Codex thread to resume.");
    return;
  }
  const cmd = `codex resume ${thread.threadId}`;
  const btn = $("#copy-cli-cmd-btn");
  const copyIcon = btn?.querySelector(".copy-icon");
  const checkIcon = btn?.querySelector(".check-icon");
  try {
    await copyToClipboard(cmd);
    await window.uit?.agent?.releaseLock?.(thread.threadId);
    if (copyIcon && checkIcon && btn) {
      copyIcon.setAttribute("hidden", "");
      checkIcon.removeAttribute("hidden");
      btn.classList.add("copied");
      setTimeout(() => {
        copyIcon.removeAttribute("hidden");
        checkIcon.setAttribute("hidden", "");
        btn.classList.remove("copied");
      }, 1500);
    }
    toast(`Copied: ${cmd} (Lock released)`);
    await checkThreadLock(thread);
  } catch (err) {
    toast(`Could not copy command. ${errorText(err)}`);
  }
}
$("#copy-cli-cmd-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  handleCopyCliCommand();
});
$("#cli-cmd-text")?.addEventListener("click", (e) => {
  e.stopPropagation();
  handleCopyCliCommand();
});
$("#resume-codex-app")?.addEventListener("click", async () => {
  closeThreadResumeMenu();
  const thread = activeThread();
  if (!thread?.threadId || !thread.cwd) {
    toast("No active Codex thread workspace to open.");
    return;
  }
  try {
    await window.uit.agent.openDesktop({
      threadId: thread.threadId,
      cwd: thread.cwd,
      title: thread.title || ""
    });
    toast("Opening thread in ChatGPT Desktop (Lock released)...");
    await checkThreadLock(thread);
  } catch (err) {
    toast(`Could not open Desktop App. ${errorText(err)}`);
  }
});
window.addEventListener("focus", async () => {
  const thread = activeThread();
  if (thread && state.view === "agent") {
    await checkThreadLock(thread);
    await syncThreadRollout(thread);
  }
});
$("#agent-input").addEventListener("click", updateMentions);
$("#agent-input").addEventListener("keyup", (event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateMentions(); });
$("#agent-form").addEventListener("submit", (event) => { event.preventDefault(); closeMention(); closeModelMenu(); sendMessage(); });
$("#stop-agent").addEventListener("click", stopThread);
$("#show-archived")?.addEventListener("click", () => {
  state.archived = !state.archived;
  renderRail();
});
$("#model-picker").addEventListener("click", () => { $("#model-menu").hidden ? openModelMenu() : closeModelMenu(); });
$("#model-menu").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeModelMenu(); $("#model-picker").focus(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = $$(".model-option", event.currentTarget);
  if (!options.length) return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
  options.forEach((option, index) => { option.tabIndex = index === next ? 0 : -1; });
  options[next].focus();
});
$("#attach-resource").addEventListener("click", () => {
  const thread = activeThread();
  if (!thread?.course) { toast("Select a course thread before attaching resources."); return; }
  const input = $("#agent-input");
  input.focus();
  updateMentions("");
});
document.addEventListener("click", (event) => {
  if (!$("#model-menu").hidden && !event.target.closest("#model-menu") && !event.target.closest("#model-picker")) closeModelMenu();
});
$("#agent-task-title").addEventListener("dblclick", () => {
  const thread = activeThread();
  if (thread?.locked) {
    toast("Cannot rename: thread is locked in an external session.");
    return;
  }
  if (thread && hasPrompt(thread)) openRenameDialog(thread);
});
$("#cancel-rename").addEventListener("click", () => $("#rename-dialog").close());
$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const thread = state.threads.find((item) => item.id === $("#rename-dialog").dataset.taskId && visibleThread(item));
  const name = $("#thread-name").value.trim();
  if (!thread || !name) return;
  thread.title = name;
  thread.renamed = true;
  persist();
  $("#rename-dialog").close();
  renderRail();
  renderConversation();
  if (thread.threadId && window.uit?.agent?.rename) {
    try {
      await window.uit.agent.rename({ threadId: thread.threadId, name });
    } catch (error) {
      console.warn("Native thread rename warning:", error);
    }
  }
});
$("#resource-new-thread").addEventListener("click", () => {
  const target = state.menuResource; $("#resource-menu").close();
  if ($("#resource-reader").open) $("#resource-reader").close();
  if (target) newThread(target.course, target.resource);
});
$("#resource-menu-download").addEventListener("click", (event) => { const target = state.menuResource; if (target) downloadResource(target.course, target.resource, event.currentTarget); });
$("#close-resource-menu").addEventListener("click", () => $("#resource-menu").close());
$("#resource-menu").addEventListener("keydown", (event) => {
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault(); const items = $$('[role="menuitem"]:not([hidden])', event.currentTarget);
    const index = items.indexOf(document.activeElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length].focus();
  }
});
$("#close-reader").addEventListener("click", () => $("#resource-reader").close());
$("#resource-reader").addEventListener("close", () => { if (!$("#resource-reader").open) { releasePreview(); state.reader = null; } });
$("#reader-download").addEventListener("click", (event) => { if (state.reader) downloadResource(state.reader.course, state.reader.resource, event.currentTarget); });
$("#reader-moodle").addEventListener("click", () => { if (state.reader) openMoodle(state.reader.course, moodleUrl(state.reader.course, state.reader.resource)); });
$("#reader-thread").addEventListener("click", () => { const target = state.reader; $("#resource-reader").close(); if (target) newThread(target.course, target.resource); });
$("#account-button").addEventListener("click", openLogin);
$("#refresh-discovery").addEventListener("click", async (event) => {
  const control = event.currentTarget; control.disabled = true;
  try { await loadCourses(true); } finally { control.disabled = false; }
});
$("#close-login").addEventListener("click", () => $("#login-modal").close());
$("#login-modal").addEventListener("close", () => { $("#login-form").reset(); });
$("#sso-login").addEventListener("click", () => authAction(() => window.uit.session.ssoLogin({ baseUrl: CURRENT_SITE }), "UIT SSO connected."));
$("#sso-disconnect").addEventListener("click", () => {
  const currentSession = state.sessions.find((s) => s.baseUrl === CURRENT_SITE);
  if (currentSession) authAction(() => window.uit.session.logout({ baseUrl: currentSession.baseUrl }), "UIT SSO disconnected.");
});
$("#legacy-relogin").addEventListener("click", () => { state.loginFormOpen = true; renderSessions(); $("#login-form input[name='username']").focus(); });
$("#legacy-disconnect").addEventListener("click", () => {
  const legacy = state.sessions.find((s) => s.baseUrl !== CURRENT_SITE);
  if (legacy) authAction(() => window.uit.session.logout({ baseUrl: legacy.baseUrl }), "Student ID disconnected.");
});
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const input = { username: fields.get("username"), password: fields.get("password"), baseUrl: fields.get("baseUrl") };
  try { await authAction(() => window.uit.session.login(input), "Student ID login connected."); }
  finally { form.elements.password.value = ""; input.password = ""; }
});
$("#logout-button").addEventListener("click", () => authAction(() => window.uit.session.logout(), "All portals disconnected. Local threads will be available when the same accounts reconnect."));
$("#agent-messages").addEventListener("click", (event) => {
  const link = event.target.closest("a.md-link");
  if (link && link.href) {
    event.preventDefault();
    if (window.uit?.shell?.openExternal) {
      window.uit.shell.openExternal(link.href).catch((err) => toast(`Could not open link: ${errorText(err)}`));
    }
  }
});
window.addEventListener("beforeunload", () => { flushStreamUpdates(); persist(); releasePreview(); });

restore();
showView("courses");
window.uit.agent.onEvent(handleAgentEvent);
(async function boot() {
  try {
    applySessions(await window.uit.session.status());
    if (state.sessions.length) await loadCourses();
  } catch (error) { renderCourseList(); appError(`Could not check account status. ${errorText(error)} Open Course accounts to reconnect.`); }
})();
(async function checkCodex() {
  const agentNav = document.querySelector('.nav-item[data-view="agent"]');
  const dot = $("#codex-dot");
  try {
    const status = await window.uit.codex.status();
    dot.classList.toggle("ready", Boolean(status.installed));
    agentNav.title = status.installed ? `Codex ready (${status.version || "installed"})` : "Codex not found / Install and sign in to Codex CLI";
    if (status.installed) ensureModels();
  } catch {
    agentNav.title = "Codex status unavailable / Check your CLI installation";
  }
})();
