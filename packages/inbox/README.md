# @aipehub/inbox

Member task inbox — the file-first half of AipeHub's human-in-the-loop (HITL)
workflow steps.

A workflow step (or any agent) dispatches a Task to the `aipehub.human/v1`
capability with a `HumanTaskPayload`. The `HumanInboxParticipant` broker
records an `InboxItem` and **suspends** the task (Phase 11 suspend/resume). The
assigned member sees the item in their `/me` inbox, submits an `InboxDecision`,
and the task resumes with that decision as its output — at which point the
parent workflow (Phase 15 revision-bound, so no drift across re-publishes)
continues.

This package is pure data + the `InboxStore` contract + the broker. The host
(`@aipehub/host`) wires the two-step resume (`HostInboxService`); the web layer
exposes `/me/inbox` over a duck-typed `InboxSurface` with no runtime dep on
this package.

## Exports

- `HUMAN_CAPABILITY`, `HUMAN_INBOX_PARTICIPANT_ID`, `NEVER_RESUME_AT` — protocol constants
- `InboxItem`, `InboxDecision`, `HumanTaskPayload`, `InboxKind`, `InboxStore`, `InboxError` — types
- `FileInboxStore` — default file-first backend (`<spaceRoot>/inbox/<itemId>.json`)
- `HumanInboxParticipant` — the broker (added in M2)

## Layout

```
.aipehub/
  inbox/
    <itemId>.json     # one item per file, atomic tmp+rename
```

Drop the directory → drop the inbox. Copy it → hand it off.
