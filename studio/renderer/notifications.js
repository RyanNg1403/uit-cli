"use strict";

window.UitNotifications = class {
  constructor() {
    this.root = document.querySelector("#view-notifications");
    this.get = (name) => this.root.querySelector(`#mail-${name}`);
    this.accounts = [];
    this.tab = "notifications";
    this.generation = 0;
    this.detailGeneration = 0;
    this.drafts = new Map();
    this.sending = new Set();
    this.get("account").onchange = () => this.reset();
    for (const tab of ["notifications", "inbox"]) this.get(tab).onclick = () => { this.tab = tab; this.reset(); };
    this.get("refresh").onclick = () => this.reset();
    this.get("more").onclick = () => void this.load(true);
    this.get("older").onclick = () => void this.loadMessages(true);
    this.get("read-all").onclick = () => void this.mutate(this.get("read-all"), () => window.uit.notifications.read({ ...this.account(), all: true }), () => this.reset());
    this.get("read-conversation").onclick = () => void this.mutate(this.get("read-conversation"), () => window.uit.inbox.read({ ...this.account(), id: this.conversation.id }), () => {
      this.conversation.unread = 0; this.renderList(); void this.counts();
    }, true);
    this.get("draft").oninput = () => this.drafts.set(this.draftKey(), this.get("draft").value);
    this.get("reply").onsubmit = (event) => { event.preventDefault(); void this.send(); };
    setInterval(() => { if (!this.root.hidden && !document.hidden) void this.counts(); }, 60_000);
  }

  element(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  text(html) {
    const parsed = new DOMParser().parseFromString(String(html), "text/html");
    parsed.querySelectorAll("script,style,iframe,object").forEach((node) => node.remove());
    parsed.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    return parsed.body.textContent || "";
  }

  date(timestamp) { return Number(timestamp) > 0 ? new Date(Number(timestamp) * 1000).toLocaleString() : "Date unavailable"; }
  account() { return this.accounts[Number(this.get("account").value)]; }
  draftKey() { return JSON.stringify([this.account()?.baseUrl, this.account()?.userId, this.conversation?.id]); }
  error(message, detail = false) { const node = this.get(detail ? "conversation-error" : "error"); node.textContent = message; node.hidden = !message; }

  setAccounts(accounts) {
    const previous = this.account();
    this.accounts = accounts.map(({ baseUrl, userId, label }) => ({ baseUrl, userId, label }));
    this.get("account").replaceChildren(...this.accounts.map((account, index) => {
      const option = this.element("option", account.label || new URL(account.baseUrl).hostname);
      option.value = String(index); return option;
    }));
    const index = this.accounts.findIndex((account) => account.baseUrl === previous?.baseUrl && account.userId === previous?.userId);
    this.get("account").value = String(Math.max(0, index));
    // Account changes invalidate all pending reads and private drafts.
    this.drafts.clear();
    this.reset();
  }

  show() { this.reset(); }
  reset() {
    this.generation++; this.detailGeneration++;
    this.items = []; this.nextOffset = null; this.conversation = null; this.loading = false;
    this.get("conversation").hidden = true;
    this.get("select").hidden = this.tab !== "inbox";
    this.get("draft").value = "";
    this.get("messages").replaceChildren();
    this.get("list").replaceChildren();
    this.get("list").setAttribute("aria-busy", "false");
    this.get("more").hidden = true;
    this.get("read-all").hidden = true;
    this.get("layout").classList.toggle("mail-split", this.tab === "inbox");
    this.error(""); this.error("", true);
    this.get("status").textContent = "";
    for (const tab of ["notifications", "inbox"]) {
      this.get(tab).setAttribute("aria-pressed", String(this.tab === tab));
      this.get(tab).textContent = tab === "inbox" ? "Inbox" : "Notifications";
    }
    this.get("refresh").disabled = !this.account();
    this.get("account").disabled = !this.accounts.length;
    if (!this.account()) { this.get("list").append(this.element("p", "Connect an account in Course accounts to view notifications and messages.", "empty")); return; }
    if (!this.root.hidden) { void this.load(); void this.counts(); }
  }

  async counts() {
    const account = this.account(), generation = this.generation;
    if (!account) return;
    try {
      const counts = await window.uit.notifications.counts(account);
      if (generation !== this.generation) return;
      ["notifications", "inbox"].forEach((tab, index) => {
        const label = tab === "inbox" ? "Inbox" : "Notifications";
        this.get(tab).textContent = counts[index] === null ? `${label} · count unavailable` : `${label}${counts[index] > 0 ? ` (${counts[index]} unread)` : ""}`;
      });
    } catch (error) { if (generation === this.generation) this.error(error.message); }
  }

  skeleton(target) {
    target.replaceChildren(...Array.from({ length: 3 }, () => this.element("div", "", "mail-skeleton")));
  }

  async load(more = false) {
    if (this.loading || !this.account()) return;
    const generation = this.generation;
    this.loading = true;
    this.error("");
    this.get("list").setAttribute("aria-busy", "true");
    this.get("status").textContent = "Loading…";
    this.get("more").disabled = true;
    if (!more) this.skeleton(this.get("list"));
    try {
      const result = await window.uit[this.tab].list({ ...this.account(), offset: more ? this.nextOffset : 0 });
      if (generation !== this.generation) return;
      this.items = [...new Map([...(more ? this.items : []), ...result.items].map((item) => [item.id, item])).values()];
      this.nextOffset = result.nextOffset;
      this.renderList();
      this.get("read-all").hidden = this.tab !== "notifications" || !(result.unread > 0);
      this.get("status").textContent = `Checked ${new Date().toLocaleTimeString()} · ${this.items.length} loaded`;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error(`${error.message} Use Refresh to try again.`);
      this.get("status").textContent = "Could not update this account.";
      this.renderList();
    } finally {
      if (generation === this.generation) {
        this.loading = false; this.get("more").disabled = false;
        this.get("list").setAttribute("aria-busy", "false");
      }
    }
  }

  button(label, action) { const button = this.element("button", label, "text-button"); button.type = "button"; button.onclick = action; return button; }

  renderList() {
    const list = this.get("list"); list.replaceChildren();
    if (!this.items.length) list.append(this.element("p", this.get("error").hidden ? (this.tab === "inbox" ? "No conversations in this account." : "You're all caught up. No notifications in this account.") : "No items loaded.", "empty"));
    for (const item of this.items) {
      if (this.tab === "inbox") {
        const button = this.element("button", undefined, "mail-conversation-item");
        button.setAttribute("aria-pressed", String(this.conversation?.id === item.id));
        button.append(this.element("strong", this.text(item.name)));
        if (item.unread) button.append(this.element("span", `${item.unread} unread`, "mail-unread"));
        const latest = item.messages[0];
        if (latest) button.append(this.element("p", this.text(latest.text), "mail-preview"), this.element("small", this.date(latest.timecreated), "muted"));
        button.onclick = () => { this.conversation = item; this.detailGeneration++; this.renderList(); void this.loadMessages(); };
        list.append(button); continue;
      }
      const card = this.element("details", undefined, "mail-notification");
      const summary = this.element("summary");
      summary.append(this.element("strong", this.text(item.subject)));
      if (!item.read) summary.append(this.element("span", "Unread", "mail-unread"));
      summary.append(this.element("small", this.date(item.timecreated), "muted"));
      card.append(summary, this.element("p", this.text(item.text), "mail-body"));
      const actions = this.element("div", undefined, "mail-toolbar");
      if (!item.read) {
        const read = this.button("Mark as read", () => void this.mutate(read, () => window.uit.notifications.read({ ...this.account(), id: item.id }), () => { item.read = true; read.remove(); summary.querySelector(".mail-unread")?.remove(); void this.counts(); }));
        actions.append(read);
      }
      if (item.canOpen) {
        const open = this.button("Open in Moodle", () => void this.mutate(open, () => window.uit.notifications.open({ ...this.account(), id: item.id }), () => {}));
        actions.append(open);
      }
      card.append(actions); list.append(card);
    }
    this.get("more").hidden = this.nextOffset === null;
  }

  async mutate(button, action, success, detail = false) {
    const generation = this.generation, detailGeneration = this.detailGeneration;
    button.disabled = true; this.error("", detail);
    try {
      await action();
      if (generation === this.generation && (!detail || detailGeneration === this.detailGeneration)) success();
    } catch (error) {
      if (generation === this.generation && (!detail || detailGeneration === this.detailGeneration)) this.error(error.message, detail);
    } finally { button.disabled = false; }
  }

  async loadMessages(older = false) {
    const generation = this.generation, detailGeneration = this.detailGeneration, account = this.account(), conversation = this.conversation;
    if (!conversation || !account) return;
    const current = () => generation === this.generation && detailGeneration === this.detailGeneration;
    this.get("conversation").hidden = false;
    this.get("select").hidden = true;
    this.get("title").textContent = this.text(conversation.name);
    this.get("older").disabled = true;
    this.get("messages").setAttribute("aria-busy", "true");
    this.error("", true);
    if (!older) {
      this.messages = []; this.members = new Map(); this.olderOffset = null;
      this.get("older").hidden = true;
      this.get("draft").value = this.drafts.get(this.draftKey()) || "";
      this.get("send").disabled = this.sending.has(this.draftKey());
      this.get("send").textContent = this.get("send").disabled ? "Sending…" : "Send reply";
      this.skeleton(this.get("messages"));
    }
    try {
      const result = await window.uit.inbox.messages({ ...account, id: conversation.id, offset: older ? this.olderOffset : 0 });
      if (!current()) return;
      for (const member of result.members) this.members.set(member.id, member.name);
      this.messages = [...new Map([...this.messages, ...result.items].map((item) => [item.id, item])).values()].sort((a, b) => a.timecreated - b.timecreated || a.id - b.id);
      this.olderOffset = result.nextOffset;
      this.get("older").hidden = this.olderOffset === null;
      this.renderMessages();
      if (!older) this.get("messages").scrollTop = this.get("messages").scrollHeight;
    } catch (error) {
      if (current()) { this.error(`${error.message} Select the conversation again to retry.`, true); this.renderMessages(); }
    } finally { if (current()) { this.get("older").disabled = false; this.get("messages").setAttribute("aria-busy", "false"); } }
  }

  renderMessages() {
    this.get("messages").replaceChildren(...this.messages.map((message) => {
      const item = this.element("article", undefined, `mail-message${message.userId === this.account().userId ? " mail-own" : ""}`);
      item.append(this.element("strong", message.userId === this.account().userId ? "You" : this.text(this.members.get(message.userId) || "Member")), this.element("p", this.text(message.text), "mail-body"), this.element("small", this.date(message.timecreated), "muted"));
      return item;
    }));
    if (!this.messages.length) this.get("messages").append(this.element("p", "No messages loaded.", "muted"));
  }

  async send() {
    const key = this.draftKey(), account = this.account(), conversation = this.conversation;
    const text = this.get("draft").value;
    if (!account || !conversation || this.sending.has(key) || !text.trim()) return;
    const generation = this.generation, detailGeneration = this.detailGeneration;
    const current = () => generation === this.generation && detailGeneration === this.detailGeneration;
    this.sending.add(key); this.get("send").disabled = true; this.get("send").textContent = "Sending…"; this.error("", true);
    try {
      const sent = await window.uit.inbox.send({ ...account, id: conversation.id, text });
      if (this.drafts.get(key) === text) this.drafts.delete(key);
      if (current()) {
        if (this.get("draft").value === text) this.get("draft").value = "";
        this.messages.push(...sent); this.renderMessages();
        this.get("messages").scrollTop = this.get("messages").scrollHeight;
      }
    } catch (error) {
      if (current()) this.error(`${error.message} Your draft is kept. Refresh the conversation to check whether it was delivered before retrying.`, true);
    } finally { this.sending.delete(key); if (current()) { this.get("send").disabled = false; this.get("send").textContent = "Send reply"; } }
  }
};
