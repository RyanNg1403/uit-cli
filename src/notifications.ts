import type { ApiClient, MoodleRecord } from "./types.js";

type Account = { baseUrl: string; userId: number; api: ApiClient };
const PAGE_SIZE = 20;

function integer(value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid ID or page offset.");
  return value;
}

function safeLink(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== "string" || !value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== new URL(baseUrl).origin || url.username || url.password) return;
    if ([...url.searchParams.keys()].some((key) => /token|sesskey|password/i.test(key))) return;
    return url.href;
  } catch { return; }
}

function message(item: MoodleRecord) {
  return { id: item.id, userId: item.useridfrom, text: String(item.text || ""), timecreated: item.timecreated };
}

export function createNotificationHandlers(accounts: () => Account[], openExternal?: (url: string) => Promise<void>) {
  const links = new WeakMap<ApiClient, Map<number, string>>();
  const handler = (operation: (account: Account, input: MoodleRecord) => Promise<unknown>) => async (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Account input is required.");
    const input = raw as MoodleRecord;
    const userId = integer(input.userId);
    const account = accounts().find((item) => item.baseUrl === input.baseUrl && item.userId === userId);
    if (!account) throw new Error("This account is disconnected. Reconnect it in Course accounts.");
    try {
      const result = await operation(account, input);
      if (!accounts().some((item) => item.api === account.api && item.userId === account.userId)) throw new Error("Account changed. Refresh this view.");
      return result;
    } catch (error) {
      const code = (error as { errorcode?: string }).errorcode;
      if (["servicerequireslogin", "invalidtoken", "requireloginerror"].includes(code || "")) throw new Error("Session expired. Sign in to this account again.", { cause: error });
      if (["servicenotavailable", "accessexception", "disabled"].includes(code || "")) throw new Error("This Moodle site does not allow this operation for your account.", { cause: error });
      throw error;
    }
  };
  return {
    "notifications:counts": handler(async ({ api, userId }) => {
      const results = await Promise.allSettled([
        api.call("message_popup_get_unread_popup_notification_count", { useridto: userId }),
        api.call("core_message_get_unread_conversations_count", { useridto: userId })
      ]);
      return results.map((result) => result.status === "fulfilled" ? Number(result.value) : null);
    }),
    "notifications:list": handler(async ({ api, userId, baseUrl }, input) => {
      const offset = integer(input.offset ?? 0, 0);
      const result = await api.call("message_popup_get_popup_notifications", { useridto: userId, newestfirst: 1, limit: PAGE_SIZE, offset });
      const items = (result.notifications || []).map((entry: MoodleRecord) => {
        const url = safeLink(entry.contexturl, baseUrl);
        let cached = links.get(api);
        if (!cached) { cached = new Map(); links.set(api, cached); }
        if (url) cached.set(entry.id, url);
        return { id: entry.id, subject: String(entry.subject || "Notification"), text: String(entry.fullmessagehtml || entry.fullmessage || entry.text || ""), timecreated: entry.timecreated, read: entry.read === true || entry.read === 1, canOpen: Boolean(url) };
      });
      return { items, unread: Number(result.unreadcount), nextOffset: items.length === PAGE_SIZE ? offset + PAGE_SIZE : null };
    }),
    "notifications:read": handler(async ({ api, userId }, input) => input.all === true
      ? api.call("core_message_mark_all_notifications_as_read", { useridto: userId })
      : api.call("core_message_mark_notification_read", { notificationid: integer(input.id) })),
    "notifications:open": handler(async ({ api }, input) => {
      const url = links.get(api)?.get(integer(input.id));
      if (!url) throw new Error("Refresh notifications before opening this link.");
      if (!openExternal) throw new Error("Opening notification links is unavailable in this client.");
      await openExternal(url);
    }),
    "inbox:list": handler(async ({ api, userId }, input) => {
      const offset = integer(input.offset ?? 0, 0);
      const result = await api.call("core_message_get_conversations", { userid: userId, limitfrom: offset, limitnum: PAGE_SIZE });
      const items = (result.conversations || []).map((entry: MoodleRecord) => ({
        id: entry.id, name: String(entry.name || (entry.members || []).filter((member: MoodleRecord) => member.id !== userId).map((member: MoodleRecord) => member.fullname).join(", ") || "Personal notes"),
        unread: Number(entry.unreadcount || 0), messages: (entry.messages || []).map(message)
      }));
      return { items, nextOffset: items.length === PAGE_SIZE ? offset + PAGE_SIZE : null };
    }),
    "inbox:messages": handler(async ({ api, userId }, input) => {
      const offset = integer(input.offset ?? 0, 0);
      const result = await api.call("core_message_get_conversation_messages", { currentuserid: userId, convid: integer(input.id), limitfrom: offset, limitnum: PAGE_SIZE, newest: 1 });
      const items = (result.messages || []).map(message);
      return { items, members: (result.members || []).map((member: MoodleRecord) => ({ id: member.id, name: String(member.fullname || "Member") })), nextOffset: items.length === PAGE_SIZE ? offset + PAGE_SIZE : null };
    }),
    "inbox:read": handler(async ({ api, userId }, input) => api.call("core_message_mark_all_conversation_messages_as_read", { userid: userId, conversationid: integer(input.id) })),
    "inbox:send": handler(async ({ api }, input) => {
      const id = integer(input.id);
      if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 4096) throw new Error("Write a message of at most 4096 UTF-8 bytes.");
      const result = await api.call("core_message_send_messages_to_conversation", { conversationid: id, messages: [{ text: input.text, textformat: 2 }] });
      return result.map(message);
    })
  };
}
