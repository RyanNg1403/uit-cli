import { describe, expect, it, vi } from "vitest";
import { addAssignmentIntervals, calendarMonth, calendarReminders, listCalendarEvents } from "../src/calendar.js";
import type { ApiClient } from "../src/types.js";

const baseUrl = "https://courses.uit.edu.vn";
const raw = { id: 7, name: "Assignment due", timestart: 1800000000, timeduration: 0, eventtype: "due", visible: 1, course: { id: 11, shortname: "CS01" }, action: { actionable: true }, url: `${baseUrl}/mod/assign/view.php?id=12&sesskey=secret` };

function account(events = [raw], extra = {}) {
  const call = vi.fn().mockResolvedValue({ initialeventsloaded: true, weeks: [{ days: [{ events }, { events }] }], ...extra });
  return { baseUrl, userId: 101, api: { call } as unknown as ApiClient };
}

describe("Moodle calendar", () => {
  it("reads explicit portal dates using Moodle midnight instead of the computer time zone", async () => {
    const current = account();
    const midnight = 1788714000;
    current.api.readFile = vi.fn().mockResolvedValue({ data: new TextEncoder().encode('<div class="date-item"><span class="date-item-label">Opened:</span> Monday, 7 September 2026, 12:00 AM</div>'), mimeType: "text/html" });
    const [event] = await listCalendarEvents(current, 2026, 9);
    event.start = new Date("2026-09-28T16:59:00Z").getTime() / 1000;
    vi.mocked(current.api.call).mockImplementation(async (name) => {
      if (name === "core_enrol_get_users_courses") return [{ id: 11 }];
      if (name === "mod_assign_get_assignments") return { courses: [{ id: 11, assignments: [{ cmid: 12, duedate: 0 }] }] };
      return { weeks: [{ days: [{ year: 2026, mday: 7, timestamp: midnight }, { year: 2026, mday: 8, timestamp: midnight + 86400 }] }] };
    });
    const merged = await addAssignmentIntervals(current, [event], 2026, 9);
    expect(merged[0].opensAt).toBe(midnight);
    expect(merged[0].start).toBe(event.start);
    expect(current.api.call).toHaveBeenCalledWith("mod_assign_get_assignments", { "courseids[0]": 11 });
  });
  it("merges assignment windows without moving deadlines or duplicating open events", async () => {
    const current = account();
    const due = new Date(2026, 8, 20, 23, 59).getTime() / 1000;
    const opensAt = new Date(2026, 8, 5).getTime() / 1000;
    const [event] = await listCalendarEvents(current, 2026, 9);
    event.start = due; event.end = due;
    vi.mocked(current.api.call).mockResolvedValueOnce([{ id: 11 }]).mockResolvedValue({ courses: [{ id: 11, assignments: [{ id: 9, cmid: 12, duedate: due - 86400, allowsubmissionsfromdate: opensAt }] }] });
    const merged = await addAssignmentIntervals(current, [event, { ...event, key: "open", type: "open", start: opensAt, deadline: false }], 2026, 9);
    expect(merged).toEqual([{ ...event, opensAt }]);
    expect(calendarReminders(merged, {}, due - 1800)[0].event.start).toBe(due);
  });

  it("includes windows crossing a month with no calendar deadline and never guesses an opening date", async () => {
    const current = account();
    const opensAt = new Date(2026, 7, 28).getTime() / 1000;
    const due = new Date(2026, 9, 3).getTime() / 1000;
    vi.mocked(current.api.call).mockResolvedValueOnce([{ id: 11 }]).mockResolvedValue({ courses: [{ id: 11, shortname: "CS01", assignments: [
      { id: 9, cmid: 12, duedate: due, allowsubmissionsfromdate: opensAt },
      { id: 10, cmid: 13, duedate: due, allowsubmissionsfromdate: 0 },
      { id: 11, cmid: 14, duedate: due, allowsubmissionsfromdate: due + 1 },
      { id: 12, cmid: 15, duedate: due, allowsubmissionsfromdate: opensAt, uservisible: false },
    ] }] });
    const merged = await addAssignmentIntervals(current, [], 2026, 9);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ opensAt, start: due, needsAction: false, assignmentId: 9 });
    vi.mocked(current.api.call).mockResolvedValueOnce([{ id: 11 }]);
    expect(await addAssignmentIntervals(current, [], 2026, 11)).toEqual([]);
  });
  it("loads the populated month using REST-compatible booleans, deduplicates spans and strips credentials", async () => {
    const current = account();
    const events = await listCalendarEvents(current, 2026, 9);
    expect(current.api.call).toHaveBeenCalledWith("core_calendar_get_calendar_monthly_view", expect.objectContaining({ year: 2026, month: 9, mini: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: raw.timestart, deadline: true, needsAction: true, courseId: 11 });
    expect(events[0].url).not.toContain("secret");
  });

  it("rejects unloaded shells and invalid dates instead of reporting an empty calendar", async () => {
    await expect(listCalendarEvents(account([], { initialeventsloaded: false }), 2026, 9)).rejects.toThrow("did not load");
    for (const month of [0, 13, "9", 1.5]) expect(() => calendarMonth(2026, month)).toThrow();
    expect(() => calendarMonth(1969, 9)).toThrow();
  });

  it("hides invisible events and does not expose external or credentialed URLs", async () => {
    expect(await listCalendarEvents(account([{ ...raw, visible: 0 }]), 2026, 9)).toEqual([]);
    for (const url of ["https://evil.test/a", "javascript:alert(1)", "https://user:pass@courses.uit.edu.vn/a"]) {
      const [event] = await listCalendarEvents(account([{ ...raw, url }]), 2026, 9);
      expect(new URL(event.url).origin).toBe(baseUrl);
      expect(new URL(event.url).username).toBe("");
    }
  });

  it("separates matching event IDs across accounts", async () => {
    const [current] = await listCalendarEvents(account(), 2026, 9);
    const [other] = await listCalendarEvents({ ...account(), userId: 202 }, 2026, 9);
    expect(current.key).not.toBe(other.key);
  });

  it("reminds once per threshold, ignores completed/past events, and reschedules changed deadlines", async () => {
    const [event] = await listCalendarEvents(account(), 2026, 9);
    const first = calendarReminders([event], {}, event.start - 7200);
    expect(first).toHaveLength(1);
    expect(first[0].hours).toBe(24);
    const sent = { [first[0].key]: event.start };
    expect(calendarReminders([event], sent, event.start - 7000)).toEqual([]);
    expect(calendarReminders([event], sent, event.start - 1800)[0].hours).toBe(1);
    expect(calendarReminders([event], {}, event.start - 1800)).toHaveLength(1);
    expect(calendarReminders([event], {}, event.start)).toEqual([]);
    expect(calendarReminders([{ ...event, needsAction: false }], {}, event.start - 1800)).toEqual([]);
    expect(calendarReminders([{ ...event, start: event.start + 3600 }], sent, event.start - 7200)).toHaveLength(1);
  });
});
