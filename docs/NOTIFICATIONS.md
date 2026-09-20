# Moodle notifications and inbox

## Experience

Notifications is a primary navigation destination with Notifications and Inbox views.
Select a connected account explicitly; pagination, unread counts, errors, and drafts
belong to that account. Show 20 entries at a time, newest first, with Load more.
Notification details expand in place. Inbox opens an existing conversation with
chronological messages, older-message pagination, and an explicit Send reply button.
Mark as read is explicit, including a separate action for all notifications.
Opening a view or refreshing never marks anything read or sends a message.

Show loading placeholders, empty states, retryable errors, and a last-checked time.
Poll unread counts every minute only while the view is visible. Refresh lists on
request so reading position does not jump. Keep reply drafts in memory per account
and conversation. Disable sending while a request is pending; never retry a send
automatically because the server may have accepted it before a connection failed.

## Boundaries

Resolve the account from server-side authenticated sessions for every RPC. Never
accept credentials from the renderer. Use the existing CSRF-protected web bridge.
Validate IDs, pagination, and message size. Moodle enforces conversation membership
and notification ownership. Return only display fields. Treat remote HTML as
untrusted and display text; do not load remote images or execute markup.
Notification links must be credential-free HTTPS links on the selected Moodle site.
Only links retrieved from Moodle may be opened by the notification RPC.

Use Moodle's notification timecreated, not inferred material upload dates. These
notifications are separate from Studio deadline reminders and forum announcements.
No browser push, background delivery guarantee, new-recipient directory, or local
message archive is introduced. Site permissions may disable individual operations;
surface that error for the selected account without hiding another account's data.

## API and verification

Use message_popup_get_popup_notifications and its unread-count API, plus
core_message_get_conversations, core_message_get_conversation_messages,
core_message_get_unread_conversations_count, core_message_mark_notification_read,
core_message_mark_all_notifications_as_read,
core_message_mark_all_conversation_messages_as_read, and
core_message_send_messages_to_conversation. Use numeric boolean arguments for
compatibility with Moodle REST tokens and AJAX sessions.

Test account isolation, pagination, safe links, input validation, server errors,
read mutations, stale responses, text rendering, and explicit sends. Live checks
are read-only; sending and marking read are verified with fixtures.

## CLI

Commands use the active CLI account, matching `uit courses`. They also honor
`UIT_TOKEN`, `UIT_BASE_URL`, and `UIT_USER_ID` like other CLI commands.
Use `uit login` for SSO or `uit login --legacy` for the legacy site.

```sh
uit notifications list
uit notifications list --full --offset 20
uit notifications counts
uit notifications read 123
uit notifications read-all
uit inbox list
uit inbox messages 456
uit inbox messages 456 --offset 20
uit inbox read 456
uit inbox send 456 "Thanks for the update."
uit --json notifications list
uit --json inbox messages 456
```

Lists return at most 20 entries and include `nextOffset` in JSON (null at the end).
JSON message pages retain Moodle's newest-first order; terminal output presents
each message page chronologically. Listing never marks anything read. Read and
send commands immediately perform the explicit requested action on Moodle.
Do not automatically retry a failed send; inspect the conversation first because
a connection failure can occur after Moodle accepted the message.
