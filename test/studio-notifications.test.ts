import { describe, expect, it, vi } from "vitest";
import { createNotificationHandlers } from "../src/studio-notifications.js";
import type { ApiClient } from "../src/types.js";

function setup() {
  const call = vi.fn().mockResolvedValue({});
  const account = { baseUrl: "https://courses.example", userId: 12, api: { call } as unknown as ApiClient };
  let accounts = [account];
  const open = vi.fn().mockResolvedValue(undefined);
  return { call, account, open, handlers: createNotificationHandlers(() => accounts, open), disconnect: () => { accounts = []; } };
}

describe("Moodle notifications and inbox", () => {
  it("isolates account IDs and rejects invalid page offsets before calling Moodle", async () => {
    const { handlers, account, call } = setup();
    for (const input of [{ ...account, userId: 13 }, { ...account, baseUrl: "https://other.example" }, { ...account, offset: -1 }, { ...account, offset: 1.5 }]) {
      await expect(handlers["notifications:list"](input)).rejects.toThrow();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("paginates notifications with REST-compatible flags and never marks reads implicitly", async () => {
    const { handlers, account, call } = setup();
    call.mockResolvedValue({ notifications: Array.from({ length: 20 }, (_, id) => ({ id: id + 1, read: false })), unreadcount: 30 });
    const result = await handlers["notifications:list"]({ ...account, offset: 20 });
    expect(result).toMatchObject({ nextOffset: 40, unread: 30 });
    expect(call).toHaveBeenCalledExactlyOnceWith("message_popup_get_popup_notifications", { useridto: 12, newestfirst: 1, limit: 20, offset: 20 });
  });

  it("only opens safe notification links obtained for the same session", async () => {
    const { handlers, account, call, open } = setup();
    call.mockResolvedValue({ notifications: [
      { id: 1, contexturl: "https://courses.example/mod/forum/discuss.php?d=1" },
      { id: 2, contexturl: "javascript:alert(1)" },
      { id: 3, contexturl: "https://other.example/" },
      { id: 4, contexturl: "https://courses.example/?sesskey=secret" }
    ] });
    await handlers["notifications:list"](account);
    for (const id of [2, 3, 4, 99]) await expect(handlers["notifications:open"]({ ...account, id })).rejects.toThrow();
    await handlers["notifications:open"]({ ...account, id: 1 });
    expect(open).toHaveBeenCalledExactlyOnceWith("https://courses.example/mod/forum/discuss.php?d=1");
  });

  it("drops responses from disconnected accounts", async () => {
    const { handlers, account, call, disconnect } = setup();
    call.mockImplementation(async () => { disconnect(); return { notifications: [] }; });
    await expect(handlers["notifications:list"](account)).rejects.toThrow("Account changed");
  });

  it("allows unread counts to fail independently", async () => {
    const { handlers, account, call } = setup();
    call.mockResolvedValueOnce(4).mockRejectedValueOnce(new Error("disabled"));
    expect(await handlers["notifications:counts"](account)).toEqual([4, null]);
  });

  it("routes explicit read actions to the selected account", async () => {
    const { handlers, account, call } = setup();
    await handlers["notifications:read"]({ ...account, id: 3 });
    await handlers["notifications:read"]({ ...account, all: true });
    await handlers["inbox:read"]({ ...account, id: 9 });
    expect(call.mock.calls).toEqual([
      ["core_message_mark_notification_read", { notificationid: 3 }],
      ["core_message_mark_all_notifications_as_read", { useridto: 12 }],
      ["core_message_mark_all_conversation_messages_as_read", { userid: 12, conversationid: 9 }]
    ]);
  });

  it("validates replies, sends plain text once, and propagates ambiguous failures without retrying", async () => {
    const { handlers, account, call } = setup();
    for (const text of [" ", "é".repeat(2049), null]) await expect(handlers["inbox:send"]({ ...account, id: 1, text })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    call.mockRejectedValue(new Error("Connection lost"));
    await expect(handlers["inbox:send"]({ ...account, id: 1, text: "<hello>" })).rejects.toThrow("Connection lost");
    expect(call).toHaveBeenCalledExactlyOnceWith("core_message_send_messages_to_conversation", { conversationid: 1, messages: [{ text: "<hello>", textformat: 2 }] });
  });

  it("reports expired sessions clearly", async () => {
    const { handlers, account, call } = setup();
    call.mockRejectedValue({ errorcode: "servicerequireslogin" });
    await expect(handlers["inbox:list"](account)).rejects.toThrow("Session expired");
  });

  it("reads older conversation messages without marking them read and strips unrelated member fields", async () => {
    const { handlers, account, call } = setup();
    call.mockResolvedValue({ messages: [{ id: 10, useridfrom: 30, text: "Hello", timecreated: 1700000000 }], members: [{ id: 30, fullname: "Teacher", email: "private@example.test" }] });
    expect(await handlers["inbox:messages"]({ ...account, id: 4, offset: 20 })).toEqual({
      items: [{ id: 10, userId: 30, text: "Hello", timecreated: 1700000000 }], members: [{ id: 30, name: "Teacher" }], nextOffset: null
    });
    expect(call).toHaveBeenCalledExactlyOnceWith("core_message_get_conversation_messages", { currentuserid: 12, convid: 4, limitfrom: 20, limitnum: 20, newest: 1 });
  });
});
