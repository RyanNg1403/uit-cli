import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { defaultApiClient } from "./api.js";
import { get, save } from "./config.js";
import type { ApiClient, MoodleRecord } from "./types.js";
import { extractH5pPackage } from "./unzip.js";
import {
  clean,
  die,
  extractUrls,
  htmlToText,
  isJsonMode,
  loading,
  out,
  parseMoodleUrl,
  sanitize,
  table,
  ts
} from "./output.js";

const execFileAsync = promisify(execFile);

interface CommandContext {
  api: ApiClient;
}

export function createContext(api: ApiClient = defaultApiClient): CommandContext {
  return { api };
}

/** Build a destination from untrusted Moodle path metadata without escaping root. */
export function courseDownloadPath(root: string, filepath: unknown, filename: unknown): string {
  const absoluteRoot = resolve(root);
  const directoryParts = String(filepath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(sanitize)
    .filter((part) => part && part !== "." && part !== "..");
  const safeFilename = sanitize(basename(String(filename || "").replace(/\\/g, "/")));
  if (!safeFilename || /^\.+$/.test(safeFilename)) throw new Error("Course file has an invalid filename.");
  const destination = resolve(absoluteRoot, ...directoryParts, safeFilename);
  if (destination !== absoluteRoot && !destination.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error("Course file destination escapes the download directory.");
  }
  return destination;
}

function formatSize(size: number): string {
  return size < 1_048_576 ? `${(size / 1024).toFixed(0)}KB` : `${(size / 1_048_576).toFixed(1)}MB`;
}

async function initSiteInfo(token: string, baseUrl: string): Promise<MoodleRecord> {
  const url = new URL(`${baseUrl}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", token);
  url.searchParams.set("wsfunction", "core_webservice_get_site_info");
  url.searchParams.set("moodlewsrestformat", "json");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<MoodleRecord>;
}

export async function requestMobileToken(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/login/token.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username,
      password,
      service: "moodle_mobile_app"
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const data = (await response.json()) as MoodleRecord;
  if (data.error) die(String(data.error));
  if (!data.token) die("Moodle did not return a token", "Check your username/password and whether Moodle Mobile services are enabled.");
  return String(data.token);
}

async function promptText(label: string): Promise<string> {
  if (!process.stdin.isTTY) die("Cannot prompt for credentials without an interactive terminal.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function promptPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY) die("Cannot prompt for credentials without an interactive terminal.");
  process.stderr.write(label);
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  }) as Writable & { isTTY?: boolean; columns?: number };
  mutedOutput.isTTY = true;
  mutedOutput.columns = process.stderr.columns || 80;

  const rl = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true
  });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

async function resolveInitToken(args: { token?: string; username?: string; password?: string }, baseUrl: string): Promise<string> {
  if (args.token) return args.token;

  const username = args.username || (await promptText("Student ID: "));
  const password = args.password || (await promptPassword("Password: "));
  if (!username) die("Student ID is required.");
  if (!password) die("Password is required.");

  loading("Requesting Moodle token...");
  return requestMobileToken(baseUrl, username, password);
}

export async function cmdInit(args: { token?: string; url: string; username?: string; password?: string }): Promise<void> {
  const baseUrl = args.url.replace(/\/+$/, "");
  const token = await resolveInitToken(args, baseUrl);
  const data = await initSiteInfo(token, baseUrl);
  if (data.exception) die(data.message || "invalid token");
  const userId = data.userid;
  save(token, userId, baseUrl);
  out({ status: "ok", user: data.fullname, user_id: userId, site: data.sitename });
}

export async function cmdCourses(args: { current?: boolean }, ctx = createContext()): Promise<void> {
  loading("Loading courses...");
  let courses = await ctx.api.call<MoodleRecord[]>("core_enrol_get_users_courses", { userid: get("userId") });
  if (!courses || courses.length === 0) {
    out([]);
    return;
  }
  if (args.current) {
    const maxCategory = Math.max(...courses.map((course) => course.category || 0));
    courses = courses.filter((course) => (course.category || 0) >= maxCategory - 20);
  }
  courses.sort((a, b) => b.id - a.id);
  const rows = courses.map((course) => ({
    id: course.id,
    short: course.shortname,
    name: clean(course.fullname)
  }));
  table(rows, [["id", "ID", 8], ["short", "SHORT", 20], ["name", "COURSE", 50]]);
}

export async function cmdContents(args: { course_id: number }, ctx = createContext()): Promise<void> {
  loading("Loading course contents...");
  const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: args.course_id });
  if (isJsonMode()) {
    const items: MoodleRecord[] = [];
    for (const section of sections) {
      for (const mod of section.modules || []) {
        const item: MoodleRecord = {
          section: clean(section.name),
          module_id: mod.id,
          type: mod.modname || "",
          name: clean(mod.name)
        };
        if (mod.contents) {
          item.files = mod.contents.map((file: MoodleRecord) => ({
            filename: file.filename,
            fileurl: file.fileurl,
            filesize: file.filesize || 0
          }));
        }
        items.push(item);
      }
    }
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  for (const section of sections) {
    if (!section.modules?.length) continue;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${clean(section.name)}`);
    console.log("=".repeat(60));
    for (const mod of section.modules) {
      const modType = mod.modname || "?";
      console.log(`  ${String(mod.id).padEnd(8)} [${String(modType).padEnd(10)}] ${clean(mod.name)}`);
      for (const file of mod.contents || []) {
        console.log(`                          -> ${file.filename}  (${formatSize(file.filesize || 0)})`);
      }
    }
  }
}

async function resolveAssignToModule(assignId: number, ctx: CommandContext): Promise<number | undefined> {
  loading("Resolving assignment ID...");
  const courses = await ctx.api.call<MoodleRecord[]>("core_enrol_get_users_courses", { userid: get("userId") });
  const params = Object.fromEntries(courses.map((course, index) => [`courseids[${index}]`, course.id]));
  const result = await ctx.api.call<MoodleRecord>("mod_assign_get_assignments", params);
  for (const course of result.courses || []) {
    for (const assignment of course.assignments || []) {
      if (assignment.id === assignId) return assignment.cmid;
    }
  }
  return undefined;
}

function findModuleFiles(sections: MoodleRecord[], moduleId: number): MoodleRecord[] {
  for (const section of sections) {
    for (const mod of section.modules || []) {
      if (mod.id === moduleId && mod.contents) {
        return mod.contents
          .filter((file: MoodleRecord) => file.type === "file")
          .map((file: MoodleRecord) => ({
            filename: file.filename,
            fileurl: file.fileurl,
            filesize: file.filesize || 0
          }));
      }
    }
  }
  return [];
}

export async function cmdView(args: { module_id: number }, ctx = createContext()): Promise<void> {
  let moduleId = args.module_id;
  loading("Loading module...");
  let info: MoodleRecord;
  try {
    info = await ctx.api.call<MoodleRecord>("core_course_get_course_module", { cmid: moduleId });
  } catch {
    const cmid = await resolveAssignToModule(moduleId, ctx);
    if (!cmid) {
      die(
        `ID ${args.module_id} is not a valid module ID or assignment ID.`,
        "Use 'uit contents <course_id>' for module IDs, 'uit deadlines' for assignment IDs."
      );
    }
    moduleId = cmid;
    info = await ctx.api.call<MoodleRecord>("core_course_get_course_module", { cmid: moduleId });
  }

  const cm = info.cm || {};
  const modname = cm.modname || "";
  const instance = cm.instance;
  const courseId = cm.course;
  const name = clean(cm.name || "");

  switch (modname) {
    case "assign":
      await viewAssign(moduleId, instance, courseId, ctx);
      return;
    case "forum":
      await viewForum(moduleId, instance, ctx);
      return;
    case "resource":
    case "folder":
      await viewResource(moduleId, courseId, name, ctx);
      return;
    case "lesson":
      await viewLesson(moduleId, instance, name, ctx);
      return;
    case "url":
      await viewUrl(moduleId, courseId, name, ctx);
      return;
    case "quiz":
      await viewQuiz(moduleId, instance, courseId, name, ctx);
      return;
    case "page":
      await viewPage(moduleId, instance, courseId, name, ctx);
      return;
    case "book":
      await viewBook(moduleId, instance, courseId, name, ctx);
      return;
    case "h5pactivity":
      await viewH5p(moduleId, courseId, name, ctx);
      return;
    default: {
      const result: MoodleRecord = { module_id: moduleId, type: modname, name, instance, course_id: courseId };
      const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: courseId });
      const files = findModuleFiles(sections, moduleId);
      if (files.length) result.files = files;
      out(result);
    }
  }
}

async function viewAssign(moduleId: number, instance: number, courseId: number, ctx: CommandContext): Promise<void> {
  const result = await ctx.api.call<MoodleRecord>("mod_assign_get_assignments", { "courseids[0]": courseId });
  let assign: MoodleRecord | undefined;
  for (const course of result.courses || []) {
    assign = (course.assignments || []).find((item: MoodleRecord) => item.id === instance);
    if (assign) break;
  }
  if (!assign) die(`Assignment instance ${instance} not found in course ${courseId}`);

  const introHtml = assign.intro || "";
  const introText = htmlToText(introHtml);
  const urls = extractUrls(introHtml);
  const subStatus = await ctx.api.call<MoodleRecord>("mod_assign_get_submission_status", { assignid: instance });
  const sub = subStatus.lastattempt?.submission || {};
  const data: MoodleRecord = {
    module_id: moduleId,
    assign_id: instance,
    type: "assign",
    name: clean(assign.name),
    due: ts(assign.duedate),
    cutoff: ts(assign.cutoffdate || 0),
    description: introText,
    submission_status: sub.status || "none"
  };
  if (urls.length) data.urls = urls;
  if (sub.timemodified) data.submitted_at = ts(sub.timemodified);
  if (assign.introattachments?.length) {
    data.attachments = assign.introattachments.map((file: MoodleRecord) => ({
      filename: file.filename,
      fileurl: file.fileurl || "",
      filesize: file.filesize || 0
    }));
  }

  const fileEnabled = (assign.configs || []).some(
    (config: MoodleRecord) =>
      config.plugin === "file" &&
      config.subtype === "assignsubmission" &&
      config.name === "enabled" &&
      config.value === "1"
  );
  const textEnabled = (assign.configs || []).some(
    (config: MoodleRecord) =>
      config.plugin === "onlinetext" &&
      config.subtype === "assignsubmission" &&
      config.name === "enabled" &&
      config.value === "1"
  );
  const submissionTypes = [];
  if (fileEnabled) submissionTypes.push("file");
  if (textEnabled) submissionTypes.push("onlinetext");
  if (submissionTypes.length) data.submission_types = submissionTypes;

  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[assign] ${data.name}`);
  console.log(`assign_id:   ${data.assign_id}  (use with 'uit submit' / 'uit status')`);
  console.log(`due:         ${data.due}`);
  if (data.cutoff) console.log(`cutoff:      ${data.cutoff}`);
  console.log(`status:      ${data.submission_status}`);
  if (data.submitted_at) console.log(`submitted:   ${data.submitted_at}`);
  if (submissionTypes.length) console.log(`accepts:     ${submissionTypes.join(", ")}`);
  if (data.attachments) {
    console.log("\nAttachments:");
    for (const file of data.attachments) console.log(`  ${file.filename}`);
  }
  if (introText) console.log(`\nDescription:\n${introText}`);
  if (urls.length) {
    console.log("\nURLs:");
    for (const url of urls) console.log(`  ${url}`);
  }
}

async function viewForum(moduleId: number, instance: number | undefined, ctx: CommandContext): Promise<void> {
  const key = typeof instance === "number" && Number.isSafeInteger(instance) && instance > 0 ? { forumid: instance } : { cmid: moduleId };
  const discussions = await ctx.api.call<MoodleRecord>("mod_forum_get_forum_discussions", key);
  const rows = (discussions.discussions || []).map((discussion: MoodleRecord) => ({
    id: discussion.discussion,
    subject: clean(discussion.subject || ""),
    author: discussion.userfullname || "",
    replies: discussion.numreplies || 0,
    date: ts(discussion.timemodified || 0)
  }));

  if (isJsonMode()) {
    console.log(JSON.stringify({ module_id: moduleId, type: "forum", name, discussions: rows }, null, 2));
    return;
  }
  console.log(`[forum] ${name}`);
  console.log(`module_id: ${moduleId}\n`);
  table(rows, [["id", "ID", 8], ["subject", "SUBJECT", 50], ["author", "AUTHOR", 20], ["replies", "RE", 4], ["date", "DATE", 18]]);
  if (rows.length) console.log("\nTip: uit view-discussion <discussion_id> to read posts");
}

async function viewH5p(moduleId: number, courseId: number, name: string, ctx: CommandContext): Promise<void> {
  let files: MoodleRecord[] = [];
  let note: string | undefined;
  try {
    files = (await fetchH5pPackages(courseId, ctx)).get(moduleId) || [];
  } catch (error) {
    note = `Could not load H5P package: ${error instanceof Error ? error.message : String(error)}`;
  }
  const data: MoodleRecord = { module_id: moduleId, type: "h5pactivity", name, files };
  if (note) data.note = note;
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[h5pactivity] ${name}`);
  console.log(`module_id: ${moduleId}\n`);
  for (const file of files) console.log(`  ${file.filename}  (${formatSize(file.filesize || 0)})`);
  if (note) console.log(`  ${note}`);
  if (files.length) console.log(`\nTip: uit download ${courseId} --module ${moduleId}   (add --extract to unpack media)`);
}

async function viewResource(moduleId: number, courseId: number, name: string, ctx: CommandContext): Promise<void> {
  const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: courseId });
  const files = findModuleFiles(sections, moduleId);
  const data = { module_id: moduleId, type: "resource", name, files };
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[resource] ${name}`);
  console.log(`module_id: ${moduleId}\n`);
  for (const file of files) console.log(`  ${file.filename}  (${formatSize(file.filesize)})`);
  if (files.length) console.log(`\nTip: uit download ${courseId} --module ${moduleId}`);
}

async function viewLesson(moduleId: number, instance: number, name: string, ctx: CommandContext): Promise<void> {
  const lesson = await ctx.api.call<MoodleRecord>("mod_lesson_get_lesson", { lessonid: instance });
  const info = lesson.lesson || {};
  const introText = htmlToText(info.intro || "");
  const urls = extractUrls(info.intro || "");
  const data: MoodleRecord = {
    module_id: moduleId,
    type: "lesson",
    name: clean(info.name || name),
    description: introText
  };
  if (urls.length) data.urls = urls;
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[lesson] ${data.name}`);
  console.log(`module_id: ${moduleId}`);
  if (introText) console.log(`\nDescription:\n${introText}`);
  if (urls.length) {
    console.log("\nURLs:");
    for (const url of urls) console.log(`  ${url}`);
  }
}

async function viewUrl(moduleId: number, courseId: number, name: string, ctx: CommandContext): Promise<void> {
  const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: courseId });
  let targetUrl = "";
  for (const section of sections) {
    for (const mod of section.modules || []) {
      if (mod.id === moduleId && mod.contents?.length) {
        targetUrl = mod.contents[0].fileurl || "";
        break;
      }
    }
  }
  const data = { module_id: moduleId, type: "url", name, url: targetUrl };
  if (isJsonMode()) console.log(JSON.stringify(data, null, 2));
  else {
    console.log(`[url] ${name}`);
    console.log(`module_id: ${moduleId}`);
    console.log(`url: ${targetUrl}`);
  }
}

async function viewQuiz(moduleId: number, instance: number, courseId: number, name: string, ctx: CommandContext): Promise<void> {
  const quizzes = await ctx.api.call<MoodleRecord>("mod_quiz_get_quizzes_by_courses", { "courseids[0]": courseId });
  const quiz = (quizzes.quizzes || []).find((item: MoodleRecord) => item.id === instance);
  if (!quiz) {
    out({ module_id: moduleId, type: "quiz", name, error: "quiz not found" });
    return;
  }
  const introText = htmlToText(quiz.intro || "");
  const attempts = await ctx.api.call<MoodleRecord>("mod_quiz_get_user_attempts", {
    quizid: instance,
    userid: get("userId"),
    status: "all"
  });
  const data = {
    module_id: moduleId,
    type: "quiz",
    name: clean(quiz.name || name),
    time_open: ts(quiz.timeopen || 0),
    time_close: ts(quiz.timeclose || 0),
    time_limit: quiz.timelimit || 0,
    grade: quiz.grade || 0,
    attempts: (attempts.attempts || []).length,
    description: introText
  };
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[quiz] ${data.name}`);
  console.log(`module_id: ${moduleId}`);
  console.log(`opens:     ${data.time_open}`);
  console.log(`closes:    ${data.time_close}`);
  if (data.time_limit) console.log(`limit:     ${data.time_limit}s`);
  console.log(`max grade: ${data.grade}`);
  console.log(`attempts:  ${data.attempts}`);
  if (introText) console.log(`\nDescription:\n${introText}`);
}

async function viewPage(moduleId: number, instance: number, courseId: number, name: string, ctx: CommandContext): Promise<void> {
  const pages = await ctx.api.call<MoodleRecord>("mod_page_get_pages_by_courses", { "courseids[0]": courseId });
  const page = (pages.pages || []).find((item: MoodleRecord) => item.id === instance);
  if (!page) {
    out({ module_id: moduleId, type: "page", name });
    return;
  }
  const contentText = htmlToText(page.content || "");
  const urls = extractUrls(page.content || "");
  const data: MoodleRecord = { module_id: moduleId, type: "page", name: clean(page.name || name), content: contentText };
  if (urls.length) data.urls = urls;
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[page] ${data.name}`);
  console.log(`module_id: ${moduleId}`);
  if (contentText) console.log(`\n${contentText}`);
  if (urls.length) {
    console.log("\nURLs:");
    for (const url of urls) console.log(`  ${url}`);
  }
}

async function viewBook(moduleId: number, instance: number, courseId: number, name: string, ctx: CommandContext): Promise<void> {
  const books = await ctx.api.call<MoodleRecord>("mod_book_get_books_by_courses", { "courseids[0]": courseId });
  const book = (books.books || []).find((item: MoodleRecord) => item.id === instance);
  const introText = book ? htmlToText(book.intro || "") : "";
  const data: MoodleRecord = { module_id: moduleId, type: "book", name, description: introText };
  const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: courseId });
  const files = findModuleFiles(sections, moduleId);
  if (files.length) data.files = files;
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`[book] ${name}`);
  console.log(`module_id: ${moduleId}`);
  if (introText) console.log(`\n${introText}`);
  if (files.length) {
    console.log("\nFiles:");
    for (const file of files) console.log(`  ${file.filename}`);
  }
}

export async function cmdViewDiscussion(args: { discussion_id: number }, ctx = createContext()): Promise<void> {
  const discussionId = args.discussion_id;
  loading("Loading discussion...");
  const result = await ctx.api.call<MoodleRecord>("mod_forum_get_discussion_posts", { discussionid: discussionId });
  const posts = result.posts || [];

  if (isJsonMode()) {
    const rows = posts.map((post: MoodleRecord) => {
      const messageHtml = post.message || "";
      return {
        id: post.id,
        author: post.author?.fullname || "",
        date: ts(post.timecreated || 0),
        subject: clean(post.subject || ""),
        message: htmlToText(messageHtml),
        urls: extractUrls(messageHtml),
        attachments: post.attachments
          ? post.attachments.map((file: MoodleRecord) => ({
              filename: file.filename,
              fileurl: file.fileurl || "",
              filesize: file.filesize || 0
            }))
          : []
      };
    });
    console.log(JSON.stringify({ discussion_id: discussionId, posts: rows }, null, 2));
    return;
  }

  for (const post of posts) {
    const author = post.author?.fullname || "?";
    const date = ts(post.timecreated || 0);
    const subject = clean(post.subject || "");
    const message = htmlToText(post.message || "");
    const urls = extractUrls(post.message || "");
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${subject}`);
    console.log(`  ${author}  |  ${date}  |  post_id: ${post.id || ""}`);
    console.log("─".repeat(60));
    if (message) console.log(message);
    if (urls.length) {
      console.log("\n  URLs:");
      for (const url of urls) console.log(`    ${url}`);
    }
    for (const attachment of post.attachments || []) console.log(`  Attachment: ${attachment.filename}`);
  }
}

export async function cmdAnnouncements(args: { course_id: number; limit?: number; full?: boolean }, ctx = createContext()): Promise<void> {
  const courseId = args.course_id;
  loading("Loading announcements...");
  const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: courseId });
  const forumMods = sections
    .flatMap((section) => section.modules || [])
    .filter((mod: MoodleRecord) => mod.modname === "forum");

  if (!forumMods.length) die("No forum found in this course");

  const isNewsName = (name: string) => /thông báo|announcement|tin tức|news/i.test(name);
  const sortedMods = [...forumMods].sort((a, b) => (isNewsName(b.name || "") ? 1 : 0) - (isNewsName(a.name || "") ? 1 : 0));

  let forumKey: { forumid?: number; cmid?: number } | undefined;
  for (const mod of sortedMods) {
    const cmInfo = await ctx.api.call<MoodleRecord>("core_course_get_course_module", { cmid: mod.id });
    const instance = Number(cmInfo.cm?.instance);
    if (Number.isSafeInteger(instance) && instance > 0) {
      forumKey = { forumid: instance };
    } else if (Number.isSafeInteger(Number(mod.id)) && Number(mod.id) > 0) {
      // SSO HTML pages may hide the forum instance while still exposing the
      // verified course-module ID; the discussions fallback accepts that key.
      forumKey = { cmid: Number(mod.id) };
    }
    if (forumKey && (cmInfo.cm?.type === "news" || isNewsName(mod.name || ""))) break;
    if (forumKey && !isNewsName(mod.name || "") && cmInfo.cm?.type !== "news") {
      forumKey = undefined;
    }
  }
  if (!forumKey) die("No announcement forum found in this course");

  const discussions = await ctx.api.call<MoodleRecord>("mod_forum_get_forum_discussions", forumKey);
  let discs = discussions.discussions || [];
  if (args.limit) discs = discs.slice(0, args.limit);

  if (args.full && discs.length) {
    if (isJsonMode()) {
      const rows = discs.map((discussion: MoodleRecord) => {
        const messageHtml = discussion.message || "";
        return {
          discussion_id: discussion.discussion,
          subject: clean(discussion.subject || ""),
          author: discussion.userfullname || "",
          date: ts(discussion.timemodified || 0),
          message: htmlToText(messageHtml),
          urls: extractUrls(messageHtml),
          replies: discussion.numreplies || 0
        };
      });
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    for (const discussion of discs) {
      const subject = clean(discussion.subject || "");
      const author = discussion.userfullname || "";
      const date = ts(discussion.timemodified || 0);
      const message = htmlToText(discussion.message || "");
      const urls = extractUrls(discussion.message || "");
      const replies = discussion.numreplies || 0;
      console.log(`\n${"─".repeat(60)}`);
      console.log(`  ${subject}`);
      console.log(`  ${author}  |  ${date}  |  ${replies} replies`);
      console.log(`  discussion_id: ${discussion.discussion}`);
      console.log("─".repeat(60));
      if (message) console.log(message);
      if (urls.length) {
        console.log("\n  URLs:");
        for (const url of urls) console.log(`    ${url}`);
      }
    }
    return;
  }

  const rows = discs.map((discussion: MoodleRecord) => ({
    id: discussion.discussion,
    subject: clean(discussion.subject || ""),
    author: discussion.userfullname || "",
    replies: discussion.numreplies || 0,
    date: ts(discussion.timemodified || 0)
  }));
  if (isJsonMode()) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    table(rows, [["id", "ID", 8], ["subject", "SUBJECT", 50], ["author", "AUTHOR", 20], ["replies", "RE", 4], ["date", "DATE", 18]]);
    if (rows.length) {
      console.log(`\nTip: uit announcements ${courseId} --full  to read content`);
      console.log("     uit view-discussion <id>  to read a specific thread");
    }
  }
}

// H5P activities expose no files through core_course_get_contents; their .h5p
// package lives behind a dedicated web service, keyed by module ID (coursemodule).
async function fetchH5pPackages(courseId: number, ctx: CommandContext): Promise<Map<number, MoodleRecord[]>> {
  const packages = new Map<number, MoodleRecord[]>();
  const response = await ctx.api.call<MoodleRecord>("mod_h5pactivity_get_h5pactivities_by_courses", {
    "courseids[0]": courseId
  });
  for (const activity of response.h5pactivities || []) {
    const files = (activity.package || [])
      .filter((file: MoodleRecord) => file.fileurl)
      .map((file: MoodleRecord) => ({
        filename: file.filename,
        fileurl: file.fileurl,
        filesize: file.filesize || 0,
        filepath: file.filepath || "/"
      }));
    if (files.length) packages.set(activity.coursemodule, files);
  }
  return packages;
}

export async function cmdDownload(
  args: { course_id: number; output?: string; module?: number; file?: string; force?: boolean; extract?: boolean },
  ctx = createContext()
): Promise<void> {
  const courseId = args.course_id;
  loading("Loading course files...");
  const courses = await ctx.api.call<MoodleRecord[]>("core_enrol_get_users_courses", { userid: get("userId") });
  const course = courses.find((entry) => entry.id === courseId);
  if (!course) {
    die(
      `${courseId} is not one of your enrolled course IDs.`,
      `If this is a module ID, target it within its course: uit download <course_id> --module ${courseId}. Run 'uit courses' for course IDs.`
    );
  }
  const destRoot = join(args.output || ".", sanitize(course.shortname || String(courseId)));
  const sections = await ctx.api.call<MoodleRecord[]>("core_course_get_contents", { courseid: courseId });
  const results: MoodleRecord[] = [];
  const warnings: string[] = [];

  const inScope = (mod: MoodleRecord) => !args.module || mod.id === args.module;
  const hasH5p = sections.some((section) =>
    (section.modules || []).some((mod: MoodleRecord) => mod.modname === "h5pactivity" && inScope(mod))
  );
  let h5pPackages = new Map<number, MoodleRecord[]>();
  if (hasH5p) {
    try {
      h5pPackages = await fetchH5pPackages(courseId, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not load H5P activity packages: ${message}`);
      if (!isJsonMode()) console.log(`  WARN  could not load H5P activity packages: ${message}`);
    }
  }

  const extractPackage = (record: MoodleRecord, dest: string) => {
    const extractDir = dest.toLowerCase().endsWith(".h5p") ? dest.slice(0, -4) : `${dest}_content`;
    try {
      record.extracted = extractH5pPackage(dest, extractDir).length;
      if (!isJsonMode()) console.log(`  EXTRACT ${record.extracted} file(s) -> ${extractDir}/`);
    } catch (error) {
      record.extract_error = error instanceof Error ? error.message : String(error);
      if (!isJsonMode()) console.log(`  EXTRACT FAILED: ${record.extract_error}`);
    }
  };

  for (const section of sections) {
    const sectionName = sanitize(section.name || "General");
    for (const mod of section.modules || []) {
      if (!inScope(mod)) continue;
      const isH5p = mod.modname === "h5pactivity";
      const files: MoodleRecord[] = isH5p
        ? h5pPackages.get(mod.id) || []
        : (mod.contents || []).filter((file: MoodleRecord) => file.type === "file");
      for (const file of files) {
        if (args.file && !String(file.filename).toLowerCase().includes(args.file.toLowerCase())) continue;
        const dest = courseDownloadPath(join(destRoot, sectionName), file.filepath, file.filename);

        if (existsSync(dest) && !args.force) {
          const record: MoodleRecord = { file: file.filename, status: "skipped", path: dest };
          if (!isJsonMode()) console.log(`  SKIP  ${dest}`);
          if (isH5p && args.extract) extractPackage(record, dest);
          results.push(record);
          continue;
        }

        try {
          if (!isJsonMode()) process.stdout.write(`  GET   ${file.filename}...`);
          await ctx.api.downloadFile(file.fileurl, dest);
          if (!isJsonMode()) console.log("  OK");
          const record: MoodleRecord = { file: file.filename, status: "ok", path: dest };
          if (isH5p && args.extract) extractPackage(record, dest);
          results.push(record);
        } catch (error) {
          let message = error instanceof Error ? error.message : String(error);
          const token = get("token");
          if (token && message.includes(token)) message = message.replaceAll(token, "***");
          results.push({ file: file.filename, status: "error", error: message });
          if (!isJsonMode()) console.log(`  FAIL: ${message}`);
        }
      }
    }
  }

  if (isJsonMode()) {
    const payload: MoodleRecord = { dest: destRoot, files: results };
    if (warnings.length) payload.warnings = warnings;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const ok = results.filter((result) => result.status === "ok").length;
    console.log(`\nDownloaded ${ok} file(s) to ${destRoot}/`);
  }
}

export async function cmdDeadlines(args: { course_id?: number; all?: boolean }, ctx = createContext()): Promise<void> {
  loading("Loading deadlines...");
  let courseIds: number[];
  if (args.course_id) {
    courseIds = [args.course_id];
  } else {
    const courses = await ctx.api.call<MoodleRecord[]>("core_enrol_get_users_courses", { userid: get("userId") });
    courseIds = courses.map((course) => course.id);
  }
  const params = Object.fromEntries(courseIds.map((id, index) => [`courseids[${index}]`, id]));
  const result = await ctx.api.call<MoodleRecord>("mod_assign_get_assignments", params);
  let rows: MoodleRecord[] = [];
  for (const course of result.courses || []) {
    for (const assignment of course.assignments || []) {
      rows.push({
        id: assignment.id,
        cmid: assignment.cmid,
        course: course.shortname,
        course_name: clean(course.fullname),
        name: clean(assignment.name),
        due: assignment.duedate,
        due_fmt: ts(assignment.duedate)
      });
    }
  }
  const now = Date.now() / 1000;
  if (!args.all) rows = rows.filter((row) => row.due === 0 || row.due > now);
  rows.sort((a, b) => (a.due || Number.POSITIVE_INFINITY) - (b.due || Number.POSITIVE_INFINITY));

  if (isJsonMode()) console.log(JSON.stringify(rows, null, 2));
  else table(rows, [["due_fmt", "DUE", 18], ["course", "COURSE", 16], ["course_name", "COURSE NAME", 45], ["name", "ASSIGNMENT", 40], ["id", "ID", 8]]);
}

export async function cmdSubmit(args: { assign_id: number; file: string }, ctx = createContext()): Promise<void> {
  const filepath = args.file;
  if (!existsSync(filepath)) die(`file not found: ${filepath}`);
  if (!isJsonMode()) console.log(`Uploading ${filepath}...`);
  const uploadResult = await ctx.api.uploadFile(filepath);
  const itemId = uploadResult.itemid;
  if (!itemId) die("upload failed", `response: ${JSON.stringify(uploadResult)}`);
  if (!isJsonMode()) console.log(`Submitting to assignment ${args.assign_id}...`);
  await ctx.api.call("mod_assign_save_submission", {
    assignmentid: args.assign_id,
    "plugindata[files_filemanager]": itemId
  });
  const status = await ctx.api.call<MoodleRecord>("mod_assign_get_submission_status", { assignid: args.assign_id });
  const sub = status.lastattempt?.submission || {};
  out({
    status: "submitted",
    assign_id: args.assign_id,
    file: basename(filepath),
    submission_status: sub.status || "unknown",
    time: ts(sub.timemodified || 0)
  });
}

export async function cmdStatus(args: { assign_id: number }, ctx = createContext()): Promise<void> {
  loading("Loading submission status...");
  let assignId = args.assign_id;
  let status: MoodleRecord | undefined;
  try {
    status = await ctx.api.call<MoodleRecord>("mod_assign_get_submission_status", { assignid: assignId });
  } catch {
    try {
      const cmInfo = await ctx.api.call<MoodleRecord>("core_course_get_course_module", { cmid: assignId });
      if (cmInfo.cm?.instance && cmInfo.cm?.modname === "assign") {
        assignId = cmInfo.cm.instance;
        status = await ctx.api.call<MoodleRecord>("mod_assign_get_submission_status", { assignid: assignId });
      }
    } catch {
      // Fall through to error
    }
    if (!status) {
      die(
        `Could not load submission status for ID ${args.assign_id}.`,
        "Make sure this is an assignment ID or module ID (see 'uit deadlines' or 'uit contents <course_id>')."
      );
    }
  }
  const sub = status.lastattempt?.submission || {};
  const feedback = status.feedback || {};
  const result: MoodleRecord = { assign_id: assignId };
  if (Object.keys(sub).length) {
    result.status = sub.status || "unknown";
    result.submitted = ts(sub.timemodified || 0);
    result.attempt = (sub.attemptnumber || 0) + 1;
    const files: MoodleRecord[] = [];
    for (const plugin of sub.plugins || []) {
      if (plugin.type !== "file") continue;
      for (const area of plugin.fileareas || []) {
        for (const file of area.files || []) files.push({ name: file.filename, size: file.filesize || 0 });
      }
    }
    if (files.length) result.files = files;
  } else {
    result.status = "none";
  }
  const grade = feedback.grade || {};
  if (grade.grade) {
    result.grade = grade.grade;
    result.graded_on = ts(grade.timemodified || 0);
  }
  out(result);
}

export async function cmdGrades(args: { course_id: number }, ctx = createContext()): Promise<void> {
  loading("Loading grades...");
  const result = await ctx.api.call<MoodleRecord>("gradereport_user_get_grade_items", {
    courseid: args.course_id,
    userid: get("userId")
  });
  const items = result.usergrades?.[0]?.gradeitems || [];
  const rows = items.map((item: MoodleRecord) => ({
    item: clean(item.itemname || item.itemtype || "?"),
    grade: item.gradeformatted || "-",
    max: item.grademax || "",
    percentage: item.percentageformatted || ""
  }));
  if (isJsonMode()) console.log(JSON.stringify(rows, null, 2));
  else table(rows, [["item", "ITEM", 50], ["grade", "GRADE", 10], ["max", "MAX", 6], ["percentage", "%", 10]]);
}

export async function cmdEvents(args: { limit: number; course_id?: number }, ctx = createContext()): Promise<void> {
  loading("Loading events...");
  const now = Math.floor(Date.now() / 1000);
  const result = await ctx.api.call<MoodleRecord>("core_calendar_get_action_events_by_timesort", {
    timesortfrom: now,
    limitnum: args.limit
  });
  let events = result.events || [];
  if (args.course_id) {
    events = events.filter((event: MoodleRecord) => event.course && typeof event.course === "object" && event.course.id === args.course_id);
  }
  const rows = events.map((event: MoodleRecord) => {
    const course = event.course || {};
    return {
      time: ts(event.timesort || 0),
      type: event.modulename || event.eventtype || "?",
      course: typeof course === "object" ? course.shortname || "" : "",
      name: clean(event.name || ""),
      url: event.url || "",
      instance: event.instance || ""
    };
  });
  if (isJsonMode()) console.log(JSON.stringify(rows, null, 2));
  else table(rows, [["time", "DUE", 18], ["type", "TYPE", 10], ["course", "COURSE", 16], ["name", "EVENT", 40]]);
}

async function openInBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
  } else {
    await execFileAsync("xdg-open", [url]);
  }
}

export async function cmdOpen(
  args: { id: string; course?: boolean; discussion?: boolean; browser?: boolean },
  ctx = createContext()
): Promise<void> {
  const base = get("baseUrl");
  const raw = args.id;
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(raw.trim());
  } catch {
    parsedUrl = undefined;
  }

  if (parsedUrl?.protocol && parsedUrl.host) {
    const url = raw.trim();
    if (isJsonMode()) console.log(JSON.stringify({ url }, null, 2));
    else {
      console.log(url);
      if (args.browser !== false) await openInBrowser(url);
    }
    return;
  }

  if (!/^-?\d+$/.test(raw)) die(`Expected an integer ID or Moodle URL, got: ${raw}`);
  const idVal = Number.parseInt(raw, 10);
  let url: string;
  if (args.course) {
    url = `${base}/course/view.php?id=${idVal}`;
  } else if (args.discussion) {
    url = `${base}/mod/forum/discuss.php?d=${idVal}`;
  } else {
    try {
      loading("Resolving module...");
      const info = await ctx.api.call<MoodleRecord>("core_course_get_course_module", { cmid: idVal });
      const modname = info.cm?.modname || "";
      url = `${base}/mod/${modname}/view.php?id=${idVal}`;
    } catch {
      const cmid = await resolveAssignToModule(idVal, ctx);
      if (!cmid) {
        die(`Could not resolve ID ${idVal}.`, "Use --course for course IDs, --discussion for discussion IDs.");
      }
      const info = await ctx.api.call<MoodleRecord>("core_course_get_course_module", { cmid });
      const modname = info.cm?.modname || "assign";
      url = `${base}/mod/${modname}/view.php?id=${cmid}`;
    }
  }

  if (isJsonMode()) {
    console.log(JSON.stringify({ url, id: idVal }, null, 2));
  } else {
    console.log(url);
    if (args.browser !== false) await openInBrowser(url);
  }
}

export async function cmdFunctions(args: { query?: string }, ctx = createContext()): Promise<void> {
  loading("Loading functions...");
  const info = await ctx.api.call<MoodleRecord>("core_webservice_get_site_info");
  let functions = info.functions || [];
  const query = args.query || "";
  if (query) functions = functions.filter((fn: MoodleRecord) => String(fn.name).toLowerCase().includes(query.toLowerCase()));

  if (isJsonMode()) {
    const rows = functions.map((fn: MoodleRecord) => ({ name: fn.name, version: fn.version || "" }));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!functions.length) {
    console.log(`(no functions matching "${query}")`);
    return;
  }
  const groups: Record<string, string[]> = {};
  for (const fn of functions) {
    const parts = String(fn.name).split("_", 3);
    const prefix = parts.length >= 2 ? parts.slice(0, 2).join("_") : parts[0];
    groups[prefix] ||= [];
    groups[prefix].push(fn.name);
  }
  for (const prefix of Object.keys(groups).sort()) {
    const names = groups[prefix].sort();
    console.log(`\n${prefix} (${names.length})`);
    for (const name of names) console.log(`  ${name}`);
  }
  console.log(`\nTotal: ${functions.length} functions`);
  if (!query) console.log("Tip: uit functions <keyword> to filter, e.g. 'uit functions assign'");
  console.log("Tip: uit raw <function_name> key=value ... to call any function");
}

export async function cmdReply(args: { post_id: number; message: string; subject?: string }, ctx = createContext()): Promise<void> {
  const postId = args.post_id;
  let subject = args.subject;
  if (!subject) {
    const parent = await ctx.api.call<MoodleRecord>("mod_forum_get_discussion_post", { postid: postId });
    const parentSubject = parent.post?.subject || "";
    subject = parentSubject ? `Re: ${parentSubject}` : "Re:";
  }
  const result = await ctx.api.call<MoodleRecord>("mod_forum_add_discussion_post", {
    postid: postId,
    subject,
    message: args.message
  });
  out({
    status: "posted",
    post_id: result.postid || "",
    parent_post_id: postId,
    subject
  });
}

export async function cmdRaw(args: { function: string; params?: string[] }, ctx = createContext()): Promise<void> {
  const params: Record<string, string> = {};
  for (const param of args.params || []) {
    const index = param.indexOf("=");
    if (index === -1) {
      params[param] = "";
    } else {
      params[param.slice(0, index)] = param.slice(index + 1);
    }
  }

  try {
    const result = await ctx.api.call(args.function, params);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    die(
      message,
      "Moodle error messages reveal required parameters. Try calling with no params to see what's needed, or check: https://docs.moodle.org/dev/Web_service_API_functions"
    );
  }
}

export function rawIdFromUrl(value: string): number | undefined {
  return parseMoodleUrl(value);
}
