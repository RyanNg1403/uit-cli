"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const STORE_KEY = "uit-studio.threads.v1";
const CURRENT_SITE = "https://courses.uit.edu.vn";
let streamFrame = null, streamPersistTimer = null, draftPersistTimer = null;
const streamUpdates = new Map();
let messageNodes = new WeakMap();
const state = {
  sessions: [], courses: [], projects: [], threads: [], activeId: null, view: "courses",
  semester: null, archived: false, selectedCourse: null, listGeneration: 0,
  detailGeneration: 0, readerGeneration: 0, reader: null, objectUrl: null,
  menuResource: null, storageError: false, storageUnreadable: false, authBusy: false,
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
function errorText(error) { return error instanceof Error ? error.message : String(error?.message || error || "Unknown error"); }
function uid() { return crypto.randomUUID(); }
function identity(ref) { return JSON.stringify([ref.baseUrl, String(ref.userId)]); }
function courseKey(course) { return JSON.stringify([course.baseUrl, String(course.userId), Number(course.id)]); }
function courseRef(course) { return { courseId: course.id, baseUrl: course.baseUrl, userId: course.userId }; }
function connected(ref) { return !!ref && state.sessions.some((session) => identity(session) === identity(ref)); }
function activeThread() { return state.threads.find((thread) => thread.id === state.activeId && visibleThread(thread)); }
function visibleThread(thread) { return connected(thread.course || thread.owner); }
function hasPrompt(thread) { return thread.prompted ?? thread.messages.some((message) => message.role === "user"); }
function addProject(course) {
  if (!state.projects.some((project) => courseKey(project) === courseKey(course))) state.projects.push(courseSnapshot(course));
}
function discardUnsent(exceptId = null) {
  state.threads = state.threads.filter((thread) => hasPrompt(thread) || thread.id === exceptId);
  if (!state.threads.some((thread) => thread.id === state.activeId)) state.activeId = null;
}
function siteLabel(course) { return course.siteLabel || (course.baseUrl === CURRENT_SITE ? "Current Moodle" : course.baseUrl?.endsWith("/sdh") ? "Legacy graduate" : "Legacy undergraduate"); }
function semesterOf(course) { return course.semester?.id ? course.semester : { id: "unknown", label: "Unknown semester", sortOrder: -1, source: "unknown" }; }
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
      id: thread.id, owner: thread.owner, course: thread.course, title: thread.title, renamed: thread.renamed,
      draft: thread.draft, resources: thread.resources.map(safeResource), messages: thread.messages,
      threadId: thread.threadId, turnId: thread.turnId, cwd: thread.cwd, started: thread.started, prompted: true, forkSource: thread.forkSource,
      archived: thread.archived, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      interrupted: thread.busy || thread.interrupted,
    }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, activeId: threads.some((thread) => thread.id === state.activeId) ? state.activeId : null, projects: state.projects, threads }));
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
      ...thread, draft: String(thread.draft || ""), busy: false, pending: false, stopping: false,
      branching: false, taskId: null, streamItem: null, approvals: [], completedTurns: new Set(),
    }));
    if (saved.projects !== undefined && (!Array.isArray(saved.projects) || !saved.projects.every((project) => project && typeof project.baseUrl === "string" && Number.isSafeInteger(project.id) && project.id > 0 && Number(project.userId) > 0))) throw new Error("Invalid saved projects");
    state.projects = saved.projects || [];
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
  $("#show-archived").hidden = !agent;
  $("#show-archived").setAttribute("aria-pressed", String(state.archived));
  const threads = state.threads.filter((thread) => hasPrompt(thread) && visibleThread(thread) && !!thread.archived === state.archived);
  const projects = agent ? state.projects.filter(connected).map((project) => state.courses.find((course) => courseKey(course) === courseKey(project)) || project) : state.courses;
  for (const group of semesterGroups(projects)) {
    const section = node("section", "semester-nav");
    section.dataset.semesterId = group.id;
    section.append(node("h3", "", group.label));
    for (const course of group.courses) {
      const project = node("div", "project");
      project.dataset.courseKey = courseKey(course);
      const line = node("div", "project-line");
      const open = button("", "course-link", () => {
        if (agent) {
          const existing = threads.find((thread) => thread.course && courseKey(thread.course) === courseKey(course));
          existing ? selectThread(existing.id) : newThread(course);
        } else openCourse(course);
      });
      open.title = `${course.fullname} / ${siteLabel(course)} / Account ${course.userId}`;
      open.append(node("span", "folder", ">"), node("span", "project-name", course.shortname || course.fullname));
      if (state.selectedCourse && courseKey(state.selectedCourse) === courseKey(course) && state.view === "course") open.setAttribute("aria-current", "page");
      line.append(open);
      if (agent) {
        const add = button("+", "icon-button project-new-thread", () => newThread(course));
        add.setAttribute("aria-label", `New thread in ${course.shortname || course.fullname}`);
        add.title = "New thread";
        line.append(add);
      }
      project.append(line);
      if (agent) {
        const list = node("div", "thread-list");
        for (const thread of threads.filter((item) => item.course && courseKey(item.course) === courseKey(course))) list.append(threadLink(thread));
        if (list.childElementCount) project.append(list);
      }
      section.append(project);
    }
    nav.append(section);
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
function threadLink(thread) {
  const link = button("", "thread-link", () => selectThread(thread.id));
  link.dataset.taskId = thread.id;
  link.title = thread.title;
  link.append(node("span", "", thread.title), node("span", "thread-state", thread.busy ? "Working" : thread.archived ? "Archived" : !thread.started ? "Draft" : ""));
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
    renderPortalCounts();
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
    row.append(node("span", "course-code", course.shortname), copy, node("span", "row-arrow", ">"));
    list.append(row);
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
  actions.append(button("New Codex thread", "primary-button", () => newThread(course)), button("Refresh resources", "secondary-button", () => openCourse(course, true)), button("Open in Moodle", "text-button", () => openMoodle(course, `${course.baseUrl}/course/view.php?id=${course.id}`)));
  detail.append(actions);
  if (refresh) {
    const status = node("div", "muted", "Refreshing resources..."); detail.append(status);
    try { await window.uit.courses.refresh(courseRef(course)); }
    catch (error) {
      if (generation === state.detailGeneration) renderLoadError(status, "Resources could not be refreshed", error, () => openCourse(course, true));
      return;
    }
    if (generation !== state.detailGeneration) return;
    status.remove();
  }
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
      if (part.key === "contents") renderModules(target, resources, course);
      else for (const item of resources) {
        const kind = part.key === "assignments" ? "assignment" : "announcement";
        const resource = resourceFrom(kind, item);
        target.append(resourceRow(course, resource));
        for (const file of resource.files) target.append(resourceRow(course, resourceFrom("file", file, resource)));
      }
      if (!resources.length) target.append(node("p", "empty", `No ${part.title.toLowerCase()} returned for this course.`));
    } catch (error) {
      if (generation === state.detailGeneration) renderLoadError(target, `${part.title} could not be loaded`, error, () => load(part, target));
    }
  };
  await Promise.all(parts.map((part) => {
    const section = node("section", "resource-section");
    const target = node("div"); target.id = part.id;
    section.append(node("h2", "", part.title), target); detail.append(section);
    return load(part, target);
  }));
}
function resourceFrom(kind, item, module) {
  const attachment = kind === "file" && ["assignment", "announcement"].includes(module?.kind);
  const reference = item.resourceRef;
  return {
    kind, referenceKind: reference?.kind || (attachment ? module.referenceKind || module.kind : kind),
    id: Number(reference?.id ?? (kind === "file" ? module.id : item.id)), moduleId: kind === "file" ? attachment ? module.moduleId : module.id : item.moduleId,
    name: item.filename || item.name || item.subject || "Untitled resource",
    fileUrl: item.fileurl, filename: item.filename, mimeType: item.mimetype,
    description: item.description || item.message || "", url: item.url || module?.url,
    files: item.files || [], dueDate: item.dueDate, author: item.author, timestamp: item.timestamp, unavailable: item.unavailable,
  };
}
function renderModules(target, modules, course) {
  const groups = new Map();
  for (const module of modules) {
    const sectionName = module.section || "Course materials";
    if (!groups.has(sectionName)) {
      const group = node("section", "section-group");
      group.append(node("h3", "section-label", sectionName));
      groups.set(sectionName, group); target.append(group);
    }
    const group = groups.get(sectionName);
    group.append(resourceRow(course, resourceFrom("module", module)));
    for (const file of module.files || []) group.append(resourceRow(course, resourceFrom("file", file, module)));
  }
}
function resourceMeta(resource) {
  if (resource.kind === "assignment") return resource.dueDate ? `Due ${new Date(resource.dueDate * 1000).toLocaleString()}` : "No due date";
  if (resource.kind === "announcement") return [resource.author, resource.timestamp ? new Date(resource.timestamp * 1000).toLocaleDateString() : ""].filter(Boolean).join(" / ");
  if (resource.kind === "module") return resource.files.length ? `${resource.files.length} file${resource.files.length === 1 ? "" : "s"}` : "Read activity";
  return "Preview file";
}
function resourceRow(course, resource) {
  const row = node("div", `resource-row${resource.kind === "file" ? " file-row" : ""}`);
  row.dataset.resourceKind = resource.kind; row.dataset.resourceId = resource.id;
  if (resource.fileUrl) row.dataset.fileUrl = resource.fileUrl;
  row.addEventListener("contextmenu", (event) => { event.preventDefault(); openResourceMenu(course, resource); });
  const preview = button("", "resource-open", () => previewResource(course, resource));
  const info = node("span", "resource-info");
  info.append(node("strong", "", resource.name), node("small", "", resourceMeta(resource)));
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
    const message = course.baseUrl === CURRENT_SITE ? "Opened in Moodle" : "Opened in Moodle. A separate browser sign-in may be required.";
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
  if (resource.kind !== "file") {
    if (resourceMeta(resource)) body.append(node("p", "muted", resourceMeta(resource)));
    body.append(node("pre", "reader-text", resource.description || "Moodle did not provide readable text for this activity. Open in Moodle to see the full activity."));
    if (resource.unavailable) body.append(node("p", "load-error", Object.values(resource.unavailable).join("\n")));
    for (const file of resource.files) body.append(resourceRow(course, resourceFrom("file", file, resource)));
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
function openProjectPicker(mode = "thread") {
  if (!state.sessions.length) { openLogin(); return; }
  $("#project-picker").dataset.mode = mode;
  $("#project-picker-title").textContent = mode === "project" ? "New project" : "Choose a project";
  $("#project-search").value = "";
  $("#project-year-field").hidden = mode !== "project";
  const years = [...new Set(state.courses.filter((course) => !state.projects.some((project) => courseKey(project) === courseKey(course))).map(projectYear))].sort((a, b) => a === "Unknown year" ? 1 : b === "Unknown year" ? -1 : b.localeCompare(a));
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
  const thread = {
    id: uid(), owner: { baseUrl: owner.baseUrl, userId: owner.userId }, course: course ? courseSnapshot(course) : null,
    title: "New thread", draft: "", resources: resource ? [safeResource(resource)] : [], messages: [],
    threadId: null, turnId: null, cwd: null, started: false, prompted: false, busy: false, pending: false,
    stopping: false, branching: false, interrupted: false, approvals: [], completedTurns: new Set(),
    taskId: null, archived: false, createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.threads.unshift(thread);
  state.archived = false;
  selectThread(thread.id);
  $("#agent-input").focus();
  return thread;
}
function selectThread(id) {
  discardUnsent(id);
  state.activeId = id;
  const thread = activeThread();
  if (thread) state.archived = !!thread.archived;
  persist(); showView("agent");
}
function renderConversation() {
  const thread = activeThread();
  $("#agent-task-title").textContent = thread?.title || "Codex";
  const picker = $("#agent-course");
  picker.hidden = !thread?.course;
  picker.dataset.courseKey = thread?.course ? courseKey(thread.course) : "";
  picker.textContent = thread?.course ? `${thread.course.shortname || thread.course.fullname} / ${siteLabel(thread.course)}` : "";
  $(".thread-actions").hidden = !thread;
  $(".composer").hidden = !thread;
  $("#rename-thread").disabled = !thread || !hasPrompt(thread);
  $("#archive-thread").textContent = thread?.archived ? "Restore" : "Archive";
  $("#agent-workspace").hidden = !thread?.cwd;
  $("#agent-workspace").textContent = thread?.cwd ? `Workspace: ${thread.cwd}` : "";
  $("#agent-input").value = thread?.draft || "";
  $("#agent-input").disabled = !thread || thread.archived;
  renderChips(); renderMessages(); renderApprovals(); updateThreadStatus();
}
function renderChips() {
  const thread = activeThread();
  const chips = $("#resource-chips"); chips.replaceChildren();
  for (const [index, resource] of (thread?.resources || []).entries()) {
    const chip = node("span", "resource-chip"); chip.dataset.resourceKind = resource.kind;
    chip.append(node("span", "", `@${resource.name}`));
    const remove = button("x", "", () => { thread.resources.splice(index, 1); persist(); renderChips(); });
    remove.setAttribute("aria-label", `Remove ${resource.name}`); remove.disabled = thread.archived;
    chip.append(remove); chips.append(chip);
  }
}
function renderMessages(changes = null) {
  const thread = activeThread();
  const box = $("#agent-messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const previousScroll = box.scrollTop;
  let inner = changes && $(".messages-inner", box);
  if (!inner) {
    changes = null;
    messageNodes = new WeakMap();
    box.replaceChildren();
  }
  if (!thread?.messages.length) {
    const empty = node("div", "thread-empty");
    if (!thread) empty.append(node("p", "muted", "No thread selected"));
    if (!thread) box.append(empty);
    return;
  }
  if (!inner) { inner = node("div", "messages-inner"); box.append(inner); }
  for (const message of changes || thread.messages) {
    const text = messageNodes.get(message);
    if (text) {
      // Keep the text node and surrounding conversation intact during streaming.
      const previous = text.textContent;
      if (message.text.startsWith(previous) && text.firstChild) text.firstChild.appendData(message.text.slice(previous.length));
      else text.textContent = message.text;
      continue;
    }
    const item = node("article", `message ${message.role}${message.kind === "error" ? " error" : ""}`);
    item.dataset.role = message.role;
    const content = node("pre", "", message.text);
    messageNodes.set(message, content);
    item.append(node("p", "message-role", message.role === "user" ? "You" : message.role === "assistant" ? "Codex" : message.label || "Activity"), content);
    if (message.resources?.length) item.append(node("p", "message-resources", message.resources.map((resource) => `@${resource.name}`).join("  ")));
    inner.append(item);
  }
  box.scrollTop = atBottom ? box.scrollHeight : previousScroll;
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
  $("#fork-agent").disabled = !thread?.threadId || thread.busy || thread.pending || thread.branching;
  $("#archive-thread").disabled = !thread || !hasPrompt(thread) || thread.busy || thread.pending || thread.branching;
  $("#send-agent").disabled = !thread || !thread.course || thread.busy || thread.pending || thread.branching || thread.archived || !thread.draft.trim();
  $("#stop-agent").hidden = !thread?.busy;
  $("#stop-agent").disabled = !thread?.threadId || !thread?.turnId || thread.stopping;
  $("#stop-agent").textContent = thread?.stopping ? "Stopping..." : "Stop";
  $("#agent-status").textContent = thread?.archived ? "Archived / Restore to continue" : thread?.branching ? "Branching thread..." : thread?.busy ? thread.approvals.length ? "Waiting for approval" : "Codex is working..." : thread?.pending ? "Finishing request..." : thread?.interrupted ? "Connection interrupted. Review the last turn before sending again." : "Ready";
}
function resourcePayload(resources) {
  return resources.map(({ kind, id, moduleId, fileUrl }) => ({ kind, id, ...(moduleId ? { moduleId } : {}), ...(fileUrl ? { fileUrl } : {}) }));
}
async function sendMessage() {
  const thread = activeThread();
  if (!thread || thread.busy || thread.pending || thread.branching || thread.archived || !thread.draft.trim()) return;
  if (!thread.course || !connected(thread.course)) { toast("Choose a connected course before sending."); return; }
  const text = thread.draft.trim();
  const resources = thread.resources.map(safeResource);
  const taskId = uid();
  thread.taskId = taskId; thread.turnId = null; thread.busy = true; thread.pending = true; thread.stopping = false; thread.approvals = [];
  thread.started = true; thread.prompted = true; thread.interrupted = false; thread.streamItem = null;
  thread.draft = ""; thread.resources = [];
  thread.messages.push({ role: "user", text, resources });
  if (!thread.renamed && thread.title === "New thread") thread.title = text.slice(0, 70);
  persist(); renderRail(); renderConversation();
  try {
    const payload = { ...courseRef(thread.course), shortname: thread.course.shortname || thread.course.fullname, taskId, resources: resourcePayload(resources), message: text };
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
    thread.turnId = result.turnId || result.id || thread.turnId;
    thread.cwd = result.workspace || thread.cwd;
    // A completion notification may arrive before the invoke response.
    if (thread.completedTurns.has(thread.turnId) || ["completed", "interrupted", "failed"].includes(result.status)) thread.busy = false;
  } catch (error) {
    if (thread.taskId !== taskId) return;
    thread.busy = false; thread.interrupted = true; thread.approvals = [];
    thread.messages.push({ role: "event", kind: "error", label: "Could not send", text: `${errorText(error)} Check Codex installation/authentication and the connected course account, then send again.` });
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
async function branchThread() {
  const source = activeThread();
  if (!source?.threadId || source.busy || source.pending || source.branching) return;
  source.branching = true;
  renderConversation();
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
        thread.messages.push({ role: "event", label: approved ? "Action approved" : "Action denied", text: approval.command });
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
  const eventMessage = (role, label) => {
    let entry = itemId ? thread.messages.find((entry) => entry.itemId === itemId && entry.turnId === thread.turnId) : null;
    if (!entry && role === "assistant" && thread.streamItem && (!itemId || !thread.streamItem.itemId || thread.streamItem.itemId === itemId)) entry = thread.streamItem;
    if (!entry) {
      entry = { role, label, text: "", itemId, turnId: thread.turnId };
      thread.messages.push(entry);
    }
    return entry;
  };
  switch (message.method) {
    case "thread/started":
    case "turn/started":
      break;
    case "agent/approval":
      if (!thread.approvals.some((approval) => approval.requestId === params.requestId)) thread.approvals.push({ requestId: params.requestId, command: String(params.command || params.reason || "No action details were provided. Deny if you cannot verify the request.") });
      break;
    case "item/agentMessage/delta": {
      const entry = eventMessage("assistant", "Codex");
      entry.text += String(params.delta || ""); thread.streamItem = entry; deltaEntry = entry; break;
    }
    case "item/commandExecution/outputDelta":
      deltaEntry = eventMessage("event", "Command output");
      deltaEntry.text += String(params.delta || ""); break;
    case "item/started":
      if (item.type === "commandExecution") eventMessage("event", "Running command").text = String(item.command || "Running workspace command...");
      break;
    case "item/completed":
      if (item.type === "agentMessage") {
        eventMessage("assistant", "Codex").text = String(item.text || thread.streamItem?.text || "");
        thread.streamItem = null;
      } else if (item.type === "commandExecution") {
        const entry = eventMessage("event", "Command completed");
        entry.label = `Command ${item.exitCode == null ? "completed" : `exited ${item.exitCode}`}`;
        entry.text = [item.command, item.aggregatedOutput || item.output || entry.text].filter(Boolean).join("\n");
      } else if (item.type === "fileChange") {
        eventMessage("event", "Files changed").text = (item.changes || []).map((change) => `${change.kind?.type || change.kind || "Changed"}: ${change.path}`).join("\n");
      }
      break;
    case "turn/completed":
      if (turnId) thread.completedTurns.add(turnId);
      thread.busy = false; thread.stopping = false; thread.streamItem = null; thread.approvals = [];
      if (params.turn?.error) thread.messages.push({ role: "event", kind: "error", label: "Turn failed", text: `${errorText(params.turn.error)} Review the error and send again to retry.` });
      if (params.turn?.status === "interrupted") thread.messages.push({ role: "event", label: "Stopped", text: "This turn was stopped. Send a message to continue." });
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
  state.listGeneration++; state.detailGeneration++;
  state.courses = state.courses.filter(connected);
  if (!activeThread()) state.activeId = null;
  if (state.reader && !connected(state.reader.course)) $("#resource-reader").close();
  if (state.menuResource && !connected(state.menuResource.course)) { $("#resource-menu").close(); state.menuResource = null; }
  if ($("#rename-dialog").open && !state.threads.some((thread) => thread.id === $("#rename-dialog").dataset.taskId && visibleThread(thread))) $("#rename-dialog").close();
  if (state.selectedCourse && !connected(state.selectedCourse)) { state.selectedCourse = null; showView("courses"); }
  $("#account-label").textContent = state.sessions.length ? `Course accounts (${state.sessions.length})` : "Connect accounts";
  renderPortalCounts();
  if ($("#project-picker").open) renderProjectOptions();
  renderSessions(); renderRail(); renderCourseList();
  if (state.view === "agent") renderConversation();
}
function renderPortalCounts() {
  const portals = $("#connected-portals"); portals.replaceChildren();
  for (const session of state.sessions) {
    const count = state.courses.filter((course) => identity(course) === identity(session)).length;
    portals.append(node("p", "", `${siteLabel(session)} / ${session.userId} / ${count} course${count === 1 ? "" : "s"}`));
  }
}
function renderDiscovery(status) {
  const lines = (status.courseDiscovery || []).map((entry) => {
    const report = entry.diagnostics;
    return `${siteLabel(entry)} / Account ${entry.userId}\n${report ? `Checked: ${report.checkedAt || "Not yet"}\nDiscovered: ${report.total}\n${report.sources.map((source) => `${source.source}: ${source.status}; ${source.count || 0} courses; ${source.pages || 0} pages${source.message ? `; ${source.message}` : ""}`).join("\n")}` : "This portal uses the enrolment REST list; no session-AJAX diagnostics."}`;
  });
  $("#discovery-report").textContent = lines.join("\n\n") || "Refresh courses to collect source counts.";
}
function renderSessions() {
  const target = $("#session-summary"); target.replaceChildren();
  for (const session of state.sessions) {
    const row = node("div", "session-row"); row.dataset.baseUrl = session.baseUrl;
    const copy = node("div");
    copy.append(node("strong", "", session.label || siteLabel(session)), node("small", "", `Connected / Account ${session.userId}`));
    const disconnect = button("Disconnect", "text-button", () => authAction(() => window.uit.session.logout({ baseUrl: session.baseUrl }), "Portal disconnected."));
    disconnect.disabled = state.authBusy; row.append(copy, disconnect); target.append(row);
  }
  const current = state.sessions.some((session) => session.baseUrl === CURRENT_SITE);
  $("#sso-login").disabled = state.authBusy || current;
  $("#sso-login").textContent = current ? "Current Moodle connected" : "Continue with UIT SSO";
  $("#logout-button").disabled = state.authBusy || !state.sessions.length;
  $$("input, select, button", $("#login-form")).forEach((control) => { control.disabled = state.authBusy; });
}
function openLogin() {
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
$("#link-course").addEventListener("click", () => {
  if (!state.sessions.length) { openLogin(); return; }
  $("#link-course-error").textContent = "";
  $("#link-course-dialog").showModal();
  $("#course-url").focus();
});
$("#cancel-link-course").addEventListener("click", () => $("#link-course-dialog").close());
$("#link-course-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const control = $("#verify-course");
  if (control.disabled) return;
  control.disabled = true; control.textContent = "Verifying access...";
  $("#link-course-error").textContent = "";
  try {
    const course = await window.uit.courses.link({ url: $("#course-url").value.trim() });
    if (!connected(course)) throw new Error("The course account disconnected during lookup.");
    const index = state.courses.findIndex((item) => courseKey(item) === courseKey(course));
    if (index < 0) state.courses.push(course); else state.courses[index] = course;
    state.semester = "all";
    $("#course-search").value = "";
    renderPortalCounts(); renderRail();
    $("#link-course-dialog").close();
    await openCourse(course);
    toast(`Verified ${course.fullname}. This course was not enrolled or modified.`);
  } catch (error) { $("#link-course-error").textContent = errorText(error); }
  finally { control.disabled = false; control.textContent = "Verify and add course"; }
});
$("#refresh-courses").addEventListener("click", () => state.sessions.length ? loadCourses(true) : openLogin());
$("#course-search").addEventListener("input", renderCourseList);
$("#semester-select").addEventListener("change", (event) => { state.semester = event.currentTarget.value; renderCourseList(); });
$("#show-archived").addEventListener("click", () => { state.archived = !state.archived; renderRail(); });
$("#agent-input").addEventListener("input", (event) => {
  const thread = activeThread();
  if (thread) {
    thread.draft = event.currentTarget.value;
    clearTimeout(draftPersistTimer); draftPersistTimer = setTimeout(persist, 300);
    updateThreadStatus();
  }
});
$("#agent-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("#agent-form").requestSubmit(); } });
$("#agent-form").addEventListener("submit", (event) => { event.preventDefault(); sendMessage(); });
$("#stop-agent").addEventListener("click", stopThread);
$("#fork-agent").addEventListener("click", branchThread);
$("#archive-thread").addEventListener("click", () => { const thread = activeThread(); if (!thread || thread.busy || thread.pending || thread.branching) return; thread.archived = !thread.archived; state.archived = thread.archived; persist(); renderRail(); renderConversation(); });
$("#rename-thread").addEventListener("click", () => {
  const thread = activeThread(); if (!thread) return;
  $("#rename-dialog").dataset.taskId = thread.id;
  $("#thread-name").value = thread.title; $("#rename-dialog").showModal(); $("#thread-name").select();
});
$("#cancel-rename").addEventListener("click", () => $("#rename-dialog").close());
$("#rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const thread = state.threads.find((item) => item.id === $("#rename-dialog").dataset.taskId && visibleThread(item));
  const name = $("#thread-name").value.trim(); if (!thread || !name) return;
  thread.title = name; thread.renamed = true; persist(); $("#rename-dialog").close(); renderRail(); renderConversation();
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
$("#sso-login").addEventListener("click", () => authAction(() => window.uit.session.ssoLogin({ baseUrl: CURRENT_SITE }), "Current Moodle connected. Add a legacy portal, or close to browse courses."));
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const input = { username: fields.get("username"), password: fields.get("password"), baseUrl: fields.get("baseUrl") };
  try { await authAction(() => window.uit.session.login(input), "Legacy Moodle connected. Both portals are available together."); }
  finally { form.elements.password.value = ""; input.password = ""; }
});
$("#logout-button").addEventListener("click", () => authAction(() => window.uit.session.logout(), "All portals disconnected. Local threads will be available when the same accounts reconnect."));
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
  try {
    const status = await window.uit.codex.status();
    $("#codex-badge").textContent = status.installed ? `Codex / ${status.version || "Installed"}` : "Codex not found / Install and sign in to Codex CLI";
  } catch { $("#codex-badge").textContent = "Codex status unavailable / Check your CLI installation"; }
})();
