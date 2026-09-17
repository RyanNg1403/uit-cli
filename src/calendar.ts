import { credentialFreeUrl } from "./api.js";
import type { ApiClient, MoodleRecord } from "./types.js";

export interface CalendarAccount {
  baseUrl: string;
  userId: number;
  api: ApiClient;
}

export interface CalendarEvent {
  key: string;
  id: number;
  baseUrl: string;
  userId: number;
  courseId?: number;
  courseName: string;
  name: string;
  description: string;
  location: string;
  start: number;
  end: number;
  opensAt?: number;
  assignmentId?: number;
  type: string;
  deadline: boolean;
  needsAction: boolean;
  url: string;
}

export function calendarMonth(year: unknown, month: unknown): { year: number; month: number } {
  if (!Number.isInteger(year) || Number(year) < 1970 || Number(year) > 9998 || !Number.isInteger(month) || Number(month) < 1 || Number(month) > 12) {
    throw new Error("Choose a valid calendar month.");
  }
  return { year: Number(year), month: Number(month) };
}

export async function listCalendarEvents(account: CalendarAccount, year: number, month: number): Promise<CalendarEvent[]> {
  calendarMonth(year, month);
  // Moodle's regular month view can return an empty shell for lazy loading.
  // Numeric booleans work with both REST form parameters and session AJAX.
  const result = await account.api.call("core_calendar_get_calendar_monthly_view", {
    year, month, courseid: 0, categoryid: 0, mini: 1, includenavigation: 0,
  });
  if (!Array.isArray(result?.weeks) || result.initialeventsloaded === false) throw new Error("Moodle did not load calendar events. Try refreshing.");
  const events = new Map<string, CalendarEvent>();
  for (const week of result.weeks) for (const day of week.days || []) for (const raw of day.events || []) {
    if (raw.visible === 0 || raw.visible === false) continue;
    const id = Number(raw.id), start = Number(raw.timestart);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(start) || start <= 0) throw new Error("Moodle returned an invalid calendar event.");
    const key = JSON.stringify([account.baseUrl, account.userId, id]);
    const course: MoodleRecord = raw.course || {};
    const base = new URL(account.baseUrl);
    const fallback = `${account.baseUrl}/calendar/view.php?view=day&time=${start}`;
    let url = new URL(fallback);
    try {
      const candidate = new URL(credentialFreeUrl(String(raw.url || raw.viewurl || fallback)) || fallback, `${account.baseUrl}/`);
      if (candidate.origin === base.origin && !candidate.username && !candidate.password && candidate.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) url = candidate;
    } catch { /* Invalid event links open the authenticated calendar day instead. */ }
    const type = String(raw.eventtype || "event");
    events.set(key, {
      key, id, baseUrl: account.baseUrl, userId: account.userId,
      courseId: Number(course.id) > 1 ? Number(course.id) : undefined,
      courseName: String(course.shortname || course.fullname || ""),
      name: String(raw.name || "Calendar event"), description: String(raw.description || ""),
      location: String(raw.location || ""), start,
      end: start + Math.max(0, Number(raw.timeduration) || 0), type,
      assignmentId: raw.modulename === "assign" && Number(raw.instance) > 0 ? Number(raw.instance) : undefined,
      deadline: type === "due" || type === "close",
      needsAction: raw.action?.actionable === true,
      url: url.href,
    });
  }
  return [...events.values()].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

export async function addAssignmentIntervals(account: CalendarAccount, events: CalendarEvent[], year: number, month: number): Promise<CalendarEvent[]> {
  const courses = await account.api.call<MoodleRecord[]>("core_enrol_get_users_courses", { userid: account.userId });
  if (!Array.isArray(courses)) throw new Error("Course dates are unavailable.");
  // Some portals return no assignments unless course IDs are supplied explicitly.
  const courseIds = [...new Set([...courses.map((course) => Number(course.id)), ...events.map((event) => event.courseId)].filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0))];
  if (!courseIds.length) return events;
  const result = await account.api.call("mod_assign_get_assignments", Object.fromEntries(courseIds.map((id, index) => [`courseids[${index}]`, id])));
  if (!Array.isArray(result?.courses)) throw new Error("Assignment dates are unavailable.");
  const monthStart = new Date(year, month - 1, 1).getTime() / 1000;
  const monthEnd = new Date(year, month, 1).getTime() / 1000;
  const merged = [...events];
  const dateMonths = new Map<string, Promise<MoodleRecord>>();
  for (const course of result.courses) for (const assignment of course.assignments || []) {
    if (assignment.uservisible === false || assignment.visible === 0) continue;
    const moduleId = Number(assignment.cmid), id = Number(assignment.id) || moduleId, courseId = Number(course.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(moduleId) || moduleId <= 0 || !Number.isSafeInteger(courseId) || courseId <= 0) continue;
    const matches = (event: CalendarEvent) => event.courseId === courseId && (event.assignmentId === id || new URL(event.url).pathname.endsWith("/mod/assign/view.php") && Number(new URL(event.url).searchParams.get("id")) === moduleId);
    const existing = merged.find((event) => event.type === "due" && matches(event));
    // Calendar dates take precedence: Moodle may apply an individual override.
    const pageDates = assignment.allowsubmissionsfromdate === undefined && account.api.readFile
      ? await assignmentPageDates(account, moduleId, dateMonths) : {};
    const due = existing?.start ?? (Number(assignment.duedate) || pageDates.due);
    const opensAt = Number(assignment.allowsubmissionsfromdate) || pageDates.open;
    if (opensAt === undefined || due === undefined || !Number.isFinite(opensAt) || opensAt <= 0 || !Number.isFinite(due) || due < opensAt || opensAt >= monthEnd || due < monthStart) continue;
    if (existing) {
      const index = merged.indexOf(existing);
      merged[index] = { ...existing, opensAt };
    } else {
      merged.push({
        key: JSON.stringify([account.baseUrl, account.userId, "assignment", id]), id,
        baseUrl: account.baseUrl, userId: account.userId, courseId,
        courseName: String(course.shortname || courses.find((entry) => Number(entry.id) === courseId)?.shortname || course.fullname || ""),
        name: String(assignment.name || "Assignment"), description: String(assignment.intro || ""), location: "",
        start: due, end: due, opensAt, assignmentId: id, type: "due", deadline: true,
        // Assignment dates alone do not establish submission status.
        needsAction: false, url: `${account.baseUrl}/mod/assign/view.php?id=${moduleId}`,
      });
    }
    for (let index = merged.length - 1; index >= 0; index--) {
      if (merged[index].type === "open" && matches(merged[index])) merged.splice(index, 1);
    }
  }
  return merged.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

async function assignmentPageDates(account: CalendarAccount, moduleId: number, months: Map<string, Promise<MoodleRecord>>): Promise<{ open?: number; due?: number }> {
  const file = await account.api.readFile!(`${account.baseUrl}/mod/assign/view.php?id=${moduleId}`);
  const html = new TextDecoder().decode(file.data);
  const dates: { open?: number; due?: number } = {};
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  // This portal exposes dates as labelled text, without datetime attributes.
  // Only parse the explicit format we can validate; never parse arbitrary prose.
  for (const item of html.matchAll(/<div\b[^>]*class=["'][^"']*\bdate-item\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const text = item[1].replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/gi, " ").trim();
    const match = /^(Opened|Opens|Due):\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text);
    if (!match) continue;
    const day = Number(match[2]), month = monthNames.indexOf(match[3].toLowerCase()) + 1, year = Number(match[4]);
    const hour = Number(match[5]), minute = Number(match[6]);
    if (!month || year < 1970 || year > 9998 || day < 1 || day > new Date(year, month, 0).getDate() || hour < 1 || hour > 12 || minute > 59) continue;
    const key = `${year}-${month}`;
    if (!months.has(key)) months.set(key, account.api.call("core_calendar_get_calendar_monthly_view", { year, month, courseid: 0, categoryid: 0, mini: 1, includenavigation: 0 }));
    const calendar = await months.get(key)!;
    const days = (calendar.weeks || []).flatMap((week: MoodleRecord) => week.days || []);
    const midnight = days.find((entry: MoodleRecord) => Number(entry.year) === year && Number(entry.mday) === day);
    const timestamp = Number(midnight?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const next = days.find((entry: MoodleRecord) => Number(entry.timestamp) > timestamp);
    // Avoid ambiguous local clock times on daylight-saving transition days.
    if (next && Number(next.timestamp) - timestamp !== 86400) continue;
    dates[match[1].toLowerCase() === "due" ? "due" : "open"] = timestamp + ((hour % 12) + (match[7].toUpperCase() === "PM" ? 12 : 0)) * 3600 + minute * 60;
  }
  return dates;
}

export function calendarReminders(events: CalendarEvent[], sent: Record<string, number>, now: number): { key: string; event: CalendarEvent; hours: number }[] {
  const reminders = [];
  for (const event of events) {
    const remaining = event.start - now;
    if (!event.deadline || !event.needsAction || remaining <= 0 || remaining > 24 * 3600) continue;
    // On startup inside the last hour, send only the most urgent reminder.
    const hours = remaining <= 3600 ? 1 : 24;
    const key = JSON.stringify([event.key, event.start, hours]);
    if (!sent[key]) reminders.push({ key, event, hours });
  }
  return reminders;
}
