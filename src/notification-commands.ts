import { Command, InvalidArgumentError } from "commander";
import { get } from "./config.js";
import { createNotificationHandlers } from "./notifications.js";
import { CliError, htmlToText, isJsonMode, out, table, ts } from "./output.js";
import type { ApiClient, MoodleRecord } from "./types.js";

function parseNumber(value: string, minimum: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new InvalidArgumentError(`Expected an integer greater than or equal to ${minimum}.`);
  }
  return number;
}

function displayText(value: unknown): string {
  // Remote message content must not emit terminal control sequences.
  return htmlToText(String(value || "")).replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\n" || character === "\t" ? character : "");
}

export function registerNotificationCommands(program: Command, api: ApiClient): void {
  async function run(action: keyof ReturnType<typeof createNotificationHandlers>, args: MoodleRecord = {}): Promise<any> {
    const userId = get("userId");
    if (!Number.isSafeInteger(userId) || !userId || userId < 1) throw new CliError("The active account has no valid user ID.", "Run uit login, or set UIT_USER_ID when using UIT_TOKEN.");
    const account = { userId, baseUrl: get("baseUrl"), api };
    return createNotificationHandlers(() => [account])[action]({ ...args, baseUrl: account.baseUrl, userId });
  }

  function page(result: MoodleRecord, kind: "notifications" | "inbox" | "messages") {
    if (isJsonMode()) { out(result); return; }
    const rows = result.items.map((item: MoodleRecord) => ({
      id: item.id,
      state: kind === "notifications" ? (item.read ? "Read" : "Unread") : String(item.unread || 0),
      date: ts(item.timecreated || item.messages?.[0]?.timecreated),
      text: displayText(kind === "notifications" ? item.subject : kind === "inbox" ? item.name : item.text),
      sender: result.members?.find((member: MoodleRecord) => member.id === item.userId)?.name || item.userId
    }));
    if (kind === "messages") {
      for (const row of rows.reverse()) {
        console.log(`[${row.id}] ${displayText(row.sender)} · ${row.date}\n${row.text}\n`);
      }
      if (!rows.length) out("(no messages)");
    } else {
      table(rows, [["id", "ID", 10], ["state", kind === "notifications" ? "Status" : "Unread", 8], ["date", "Date", 19], ["text", kind === "notifications" ? "Subject" : "Conversation", 0]]);
      if (kind === "notifications") out(`Unread notifications: ${result.unread}`);
    }
    if (result.nextOffset !== null) out(`More available: repeat this command with --offset ${result.nextOffset}`);
  }

  const notifications = program.command("notifications").description("Moodle notifications for the active account (separate from course announcements)");
  notifications.command("list").description("List the latest 20 notifications without marking them read")
    .option("--offset <number>", "Skip this many notifications", (value) => parseNumber(value, 0), 0)
    .option("--full", "Include notification bodies in text output")
    .action(async (options) => {
      const result = await run("notifications:list", { offset: options.offset });
      page(result, "notifications");
      if (options.full && !isJsonMode()) for (const item of result.items) out(`\n[${item.id}] ${displayText(item.subject)}\n${displayText(item.text)}`);
    });
  notifications.command("counts").description("Show unread notification and conversation counts")
    .action(async () => {
      const [notifications, conversations] = await run("notifications:counts");
      if (notifications === null && conversations === null) throw new CliError("Could not read unread counts.", "Check your active account with uit notifications list or sign in again.");
      out({ notifications: notifications ?? (isJsonMode() ? null : "Unavailable"), conversations: conversations ?? (isJsonMode() ? null : "Unavailable") });
    });
  notifications.command("read").description("Mark one notification as read on Moodle")
    .argument("<notification_id>", "Notification ID", (value) => parseNumber(value, 1))
    .action(async (id) => { await run("notifications:read", { id }); out({ status: "read", notificationId: id }); });
  notifications.command("read-all").description("Mark all notifications in the active account as read on Moodle")
    .action(async () => { await run("notifications:read", { all: true }); out({ status: "read", all: true }); });

  const inbox = program.command("inbox").description("Moodle conversations for the active account");
  inbox.command("list").description("List 20 conversations without marking messages read")
    .option("--offset <number>", "Skip this many conversations", (value) => parseNumber(value, 0), 0)
    .action(async (options) => page(await run("inbox:list", { offset: options.offset }), "inbox"));
  inbox.command("messages").description("Read the latest 20 messages; larger offsets load older messages")
    .argument("<conversation_id>", "Conversation ID", (value) => parseNumber(value, 1))
    .option("--offset <number>", "Skip this many newest messages", (value) => parseNumber(value, 0), 0)
    .action(async (id, options) => page(await run("inbox:messages", { id, offset: options.offset }), "messages"));
  inbox.command("read").description("Mark all messages in a conversation as read on Moodle")
    .argument("<conversation_id>", "Conversation ID", (value) => parseNumber(value, 1))
    .action(async (id) => { await run("inbox:read", { id }); out({ status: "read", conversationId: id }); });
  inbox.command("send").description("Send one plain-text reply to an existing conversation (never retried automatically)")
    .argument("<conversation_id>", "Conversation ID", (value) => parseNumber(value, 1))
    .argument("<message>", "Message text, at most 4096 UTF-8 bytes")
    .action(async (id, text) => {
      const messages = await run("inbox:send", { id, text });
      out({ status: "sent", conversationId: id, messageIds: messages.map((message: MoodleRecord) => message.id) });
    });
}
