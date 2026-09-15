"use strict";

window.UitCalendar = class {
  constructor({ notify, navigate }) {
    this.root = document.querySelector("#view-calendar");
    this.date = new Date();
    this.date.setDate(1);
    this.events = [];
    this.accounts = [];
    this.generation = 0;
    this.day = null;
    this.get = (id) => this.root.querySelector(`#calendar-${id}`);
    this.get("previous").onclick = () => this.move(-1);
    this.get("next").onclick = () => this.move(1);
    this.get("today").onclick = () => { this.date = new Date(); this.date.setDate(1); this.day = null; void this.load(); };
    this.get("jump").onchange = () => {
      const [year, month] = this.get("jump").value.split("-").map(Number);
      if (year >= 1970 && year <= 9998 && month >= 1 && month <= 12) { this.date = new Date(year, month - 1, 1); this.day = null; void this.load(); }
    };
    this.get("refresh").onclick = () => { void this.load(true); };
    this.get("all-days").onclick = () => { this.day = null; this.render(); };
    for (const id of ["course", "type", "search"]) this.get(id).addEventListener("input", () => this.render());
    this.get("account").onchange = () => { this.courseOptions(); this.render(); };
    this.get("reminders").onchange = async () => {
      const input = this.get("reminders");
      input.disabled = true;
      try { this.settings(await window.uit.calendar.settings({ enabled: input.checked })); }
      catch (error) { input.checked = !input.checked; this.get("reminder-status").textContent = error.message; }
      finally { input.disabled = false; }
    };
    window.uit.calendar.onReminder((event) => notify(event.body));
    window.uit.calendar.onNavigate(navigate);
    setInterval(() => { if (!this.root.hidden) void this.load(); }, 5 * 60_000);
  }

  element(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  text(html) {
    const document = new DOMParser().parseFromString(String(html), "text/html");
    document.querySelectorAll("script, style, iframe, object").forEach((element) => element.remove());
    return document.body.textContent || "";
  }

  show() { void this.load(); }

  reset() {
    this.generation++;
    this.events = [];
    this.accounts = [];
    this.day = null;
    this.options("account", "All accounts", []);
    this.courseOptions();
    this.render();
    if (!this.root.hidden) void this.load();
  }

  move(offset) {
    const next = new Date(this.date.getFullYear(), this.date.getMonth() + offset, 1);
    if (next.getFullYear() < 1970 || next.getFullYear() > 9998) return;
    this.date = next;
    this.day = null;
    void this.load();
  }

  settings(result) {
    this.get("reminders").checked = result.enabled;
    this.get("reminder-status").textContent = result.error || (result.supported ? "Desktop and in-app reminders are available while Studio is running." : "Desktop notifications are unavailable. In-app reminders are available while Studio is running.");
  }

  async load(refresh = false) {
    const generation = ++this.generation;
    const year = this.date.getFullYear(), month = this.date.getMonth() + 1;
    this.events = [];
    this.render();
    this.get("refresh").disabled = true;
    this.get("status").textContent = "Loading calendar…";
    this.get("error").hidden = true;
    this.root.setAttribute("aria-busy", "true");
    try {
      const result = await window.uit.calendar.list({ year, month, refresh });
      if (generation !== this.generation) return;
      this.events = result.events;
      this.accounts = result.accounts;
      this.options("account", "All accounts", this.accounts.map((account) => [JSON.stringify([account.baseUrl, account.userId]), `${new URL(account.baseUrl).host}${new URL(account.baseUrl).pathname.replace(/\/$/, "")} · ${account.userId}`]));
      this.courseOptions();
      this.render();
      this.get("error").hidden = !result.errors.length;
      this.get("error").textContent = result.errors.map((error) => error.message).join(" ");
      this.get("status").textContent = !this.accounts.length ? "Connect a course account to see your calendar." : `${result.errors.length ? "Some accounts could not be updated. " : ""}Checked ${new Date(result.updatedAt).toLocaleTimeString()} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    } catch (error) {
      if (generation !== this.generation) return;
      this.get("error").hidden = false;
      this.get("error").textContent = error.message;
      this.get("status").textContent = "Calendar could not be loaded. Try refreshing.";
      this.get("agenda").replaceChildren();
    } finally {
      if (generation === this.generation) { this.get("refresh").disabled = false; this.root.removeAttribute("aria-busy"); }
    }
    try {
      const settings = await window.uit.calendar.settings();
      if (generation === this.generation) this.settings(settings);
    } catch (error) { if (generation === this.generation) this.get("reminder-status").textContent = error.message; }
  }

  options(id, label, entries) {
    const select = this.get(id), previous = select.value;
    select.replaceChildren(new Option(label, ""), ...entries.map(([value, text]) => new Option(text, value)));
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  accountKey(event) { return JSON.stringify([event.baseUrl, event.userId]); }
  courseKey(event) { return JSON.stringify([event.baseUrl, event.userId, event.courseId || 0]); }

  courseOptions() {
    const account = this.get("account").value;
    const courses = new Map(this.events.filter((event) => !account || this.accountKey(event) === account).map((event) => [this.courseKey(event), `${event.courseName || "General events"} · ${new URL(event.baseUrl).host}`]));
    this.options("course", "All courses", [...courses].sort((a, b) => a[1].localeCompare(b[1])));
  }

  filtered() {
    const account = this.get("account").value, course = this.get("course").value;
    const type = this.get("type").value, query = this.get("search").value.trim().toLocaleLowerCase();
    return this.events.filter((event) => (!account || this.accountKey(event) === account) && (!course || this.courseKey(event) === course)
      && (type === "all" || event.deadline && (type !== "action" || event.needsAction))
      && (!query || `${this.text(event.name)} ${event.courseName} ${this.text(event.description)}`.toLocaleLowerCase().includes(query)));
  }

  onDay(event, day) {
    const start = new Date(this.date.getFullYear(), this.date.getMonth(), day).getTime() / 1000;
    const end = new Date(this.date.getFullYear(), this.date.getMonth(), day + 1).getTime() / 1000;
    if (event.opensAt) return event.opensAt < end && event.start >= start;
    return event.start < end && (event.end > start || event.start >= start);
  }

  eventLabel(event) {
    return `${event.courseName ? `${event.courseName} · ` : ""}${this.text(event.name)}`;
  }

  selectDay(day) {
    this.day = this.day === day ? null : day;
    this.render();
    this.get("grid").querySelector(`[data-day="${day}"]`).focus();
  }

  revealEvent(key) {
    this.day = null;
    this.render();
    const card = [...this.get("agenda").children].find((element) => element.dataset.eventKey === key);
    if (!card) return;
    card.open = true;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.querySelector("summary").focus({ preventScroll: true });
  }

  renderWeek(first, last, filtered, today) {
    const year = this.date.getFullYear(), month = this.date.getMonth();
    const week = this.element("div", undefined, "calendar-week");
    const occupied = Array.from({ length: 3 }, () => Array(7).fill(false));
    const hidden = Array(7).fill(0);
    const segments = filtered.map((event) => {
      const days = Array.from({ length: 7 }, (_, index) => first + index).filter((day) => day > 0 && day <= last && this.onDay(event, day));
      return { event, days };
    }).filter(({ days }) => days.length).sort((a, b) => (a.event.opensAt || a.event.start) - (b.event.opensAt || b.event.start) || b.days.length - a.days.length || a.event.key.localeCompare(b.event.key));
    const bars = [];
    let lanes = 2;
    for (const { event, days } of segments) {
      const from = days[0] - first, to = days.at(-1) - first;
      const lane = occupied.findIndex((row) => row.slice(from, to + 1).every((value) => !value));
      if (lane === -1) { for (const day of days) hidden[day - first]++; continue; }
      occupied[lane].fill(true, from, to + 1);
      lanes = Math.max(lanes, lane + 1);
      const bar = this.element("button", undefined, `calendar-segment${event.opensAt ? " calendar-window" : event.deadline ? " calendar-due-point" : " calendar-single-event"}`);
      bar.type = "button";
      const continuesBefore = this.onDay(event, days[0] - 1);
      const continuesAfter = this.onDay(event, days.at(-1) + 1);
      bar.classList.toggle("continues-before", continuesBefore);
      bar.classList.toggle("continues-after", continuesAfter);
      bar.classList.toggle("ends-deadline", event.deadline && !continuesAfter);
      bar.style.gridColumn = `${from + 1} / ${to + 2}`;
      bar.style.gridRow = String(lane + 2);
      const due = new Date(event.start * 1000);
      const dates = event.opensAt ? `Opens ${new Date(event.opensAt * 1000).toLocaleString()} → Due ${due.toLocaleString()}` : due.toLocaleString();
      bar.title = `${this.eventLabel(event)}\n${dates}`;
      bar.setAttribute("aria-label", `${this.eventLabel(event)}. ${dates}${continuesBefore ? ". Continues from previous week" : ""}${continuesAfter ? ". Continues next week" : ""}`);
      bar.append(this.element("span", this.eventLabel(event), "calendar-segment-label"));
      if (event.deadline && !continuesAfter) bar.append(this.element("span", "Due", "calendar-segment-end"));
      bar.onclick = () => this.revealEvent(event.key);
      bars.push(bar);
    }
    week.style.setProperty("--calendar-lanes", String(lanes));
    for (let index = 0; index < 7; index++) {
      const day = first + index;
      const valid = day > 0 && day <= last;
      const cell = this.element(valid ? "button" : "div", undefined, valid ? "calendar-day" : "calendar-blank");
      cell.style.gridColumn = String(index + 1);
      cell.style.gridRow = "1 / -1";
      if (valid) {
        const surface = this.element("div", undefined, "calendar-date-surface");
        surface.style.gridColumn = String(index + 1);
        surface.style.gridRow = "1 / -1";
        surface.classList.toggle("is-selected", this.day === day);
        week.append(surface);
        cell.style.gridRow = "1";
        cell.type = "button";
        cell.dataset.day = String(day);
        cell.setAttribute("aria-label", `${new Date(year, month, day).toLocaleDateString(undefined, { dateStyle: "full" })}, ${filtered.filter((event) => this.onDay(event, day)).length} events`);
        cell.setAttribute("aria-pressed", String(this.day === day));
        if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) cell.setAttribute("aria-current", "date");
        cell.append(this.element("span", String(day), "calendar-day-number"));
        cell.onclick = () => this.selectDay(day);
      }
      week.append(cell);
      if (hidden[index]) {
        const more = this.element("button", `+${hidden[index]} more`, "calendar-more");
        more.style.gridColumn = String(index + 1);
        more.style.gridRow = String(lanes + 2);
        more.setAttribute("aria-label", `${hidden[index]} more events on ${new Date(year, month, day).toLocaleDateString()}`);
        more.onclick = () => { this.day = day; this.render(); this.get("agenda-title").scrollIntoView({ block: "start", behavior: "smooth" }); };
        week.append(more);
      }
    }
    week.append(...bars);
    return week;
  }

  render() {
    const year = this.date.getFullYear(), month = this.date.getMonth(), today = new Date();
    this.get("month").textContent = this.date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    this.get("jump").value = `${year}-${String(month + 1).padStart(2, "0")}`;
    const filtered = this.filtered(), grid = this.get("grid");
    grid.replaceChildren();
    for (const weekday of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) grid.append(this.element("div", weekday, "calendar-weekday"));
    const days = new Date(year, month + 1, 0).getDate();
    for (let first = 1 - (this.date.getDay() + 6) % 7; first <= days; first += 7) grid.append(this.renderWeek(first, days, filtered, today));
    this.get("all-days").hidden = this.day === null;
    this.get("agenda-title").textContent = this.day === null ? "Events this month" : new Date(year, month, this.day).toLocaleDateString(undefined, { dateStyle: "full" });
    const events = filtered.filter((event) => this.day === null ? Array.from({ length: days }, (_, index) => index + 1).some((day) => this.onDay(event, day)) : this.onDay(event, this.day));
    const agenda = this.get("agenda");
    agenda.replaceChildren();
    if (!events.length) agenda.append(this.element("p", "No events for this selection. Moodle events and assignments with dates appear here.", "empty"));
    for (const event of events) {
      const card = this.element("details", undefined, "calendar-event");
      card.dataset.eventKey = event.key;
      const summary = this.element("summary");
      summary.append(this.element("strong", this.text(event.name)));
      const past = event.start * 1000 < Date.now();
      const status = event.deadline ? past ? event.needsAction ? "Overdue" : "Past deadline" : event.needsAction ? "Needs action" : "Deadline" : this.text(event.type);
      summary.append(this.element("span", status, `calendar-event-status${event.deadline && event.needsAction ? " calendar-deadline" : ""}`));
      summary.append(this.element("span", `${new Date(event.start * 1000).toLocaleString()}${event.end > event.start ? ` – ${new Date(event.end * 1000).toLocaleString()}` : ""} · ${event.courseName || "General event"} · ${new URL(event.baseUrl).host}`, "calendar-event-meta"));
      card.append(summary);
      if (event.opensAt) {
        const window = this.element("div", undefined, "calendar-window-detail");
        for (const [label, timestamp] of [["Submissions open", event.opensAt], ["Deadline", event.start]]) {
          const endpoint = this.element("div");
          endpoint.append(this.element("span", label, "calendar-event-meta"), this.element("strong", new Date(timestamp * 1000).toLocaleString()));
          window.append(endpoint);
        }
        const remaining = Math.ceil((event.start * 1000 - Date.now()) / 3600_000);
        const label = Date.now() < event.opensAt * 1000 ? "Not open yet" : remaining <= 0 ? "Deadline passed" : remaining < 24 ? `${remaining}h until deadline` : `${Math.ceil(remaining / 24)} days until deadline`;
        window.append(this.element("span", label, "calendar-window-countdown"));
        card.append(window);
      }
      if (event.description) card.append(this.element("p", this.text(event.description), "calendar-description"));
      if (event.location) card.append(this.element("p", `Location: ${this.text(event.location)}`));
      const open = this.element("button", "Open in Moodle", "secondary-button");
      open.onclick = async () => {
        open.disabled = true;
        try { await window.uit.calendar.open({ key: event.key }); }
        catch (error) { this.get("error").hidden = false; this.get("error").textContent = error.message; }
        finally { open.disabled = false; }
      };
      card.append(open);
      agenda.append(card);
    }
  }
};
