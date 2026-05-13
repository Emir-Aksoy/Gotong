# Joining as a human

AipeHub treats humans as first-class participants. There are two
roles, each with its own web UI:

| Role | URL | What they can do |
|---|---|---|
| **Admin** | `https://hub.example.com/admin` | Approve agent applications, dispatch tasks, evaluate completed work, invite more admins, retry failed tasks |
| **Worker** | `https://hub.example.com/` | Pick a nickname + capabilities, receive tasks, complete or reject them, leave anytime |

Both roles persist across server restarts — your HttpOnly cookie maps
to a row in `admins.json` / `workers.json` on the server. There is **no
browser storage**, so clearing cookies is the only way to "log out".

---

## I'm a worker — how do I get in?

You only need a URL the admin gave you. It looks like:

```
https://hub.example.com/
```

(or for a LAN room: `http://192.168.1.42:3000/`)

1. Open the URL.
2. Pick a nickname. The page tells you whether it's taken.
3. Tick the capabilities you can help with. The admin's instructions
   should list which capability strings the room uses; common ones are
   `draft`, `review`, `translate`, `code`, `approve`.
4. Click **Join**. The server writes a row in `workers.json` and sets
   a cookie on your browser. You are now a participant.

The page splits into three panes:

- **Pending tasks** — anything dispatched to your `id` or a capability
  you advertised. Each task has a payload preview and **Complete** /
  **Reject** buttons.
- **Live transcript** — every event in the room since you joined, plus
  whatever the admin's "show history" range is.
- **Your identity** — your id, capabilities, and a **Leave** button.

### "Leave" vs "close tab"

- Closing the tab keeps your cookie. Reopening the URL on the same
  browser puts you straight back in, even after a server restart.
- Clicking **Leave** drops the cookie and removes your row from
  `workers.json`. To come back you re-do step 1–4 with the same
  nickname.

If you leave and re-join with the same nickname later, the server
warns "this nickname is reserved by another session" — that's a
deliberate guardrail so two people don't accidentally pretend to be the
same worker. Pick another nickname or ask the admin to clean up.

### How a task arrives

The admin dispatches a task. The Hub's scheduler picks who to send it
to (you, all humans, all agents with a capability, etc). When it lands
in your pane:

```
┌─── new task ─────────────────────────────────┐
│ from: admin    capability: review            │
│ title: review the draft about typescript     │
│ payload: { text: "TypeScript is …" }         │
│                                              │
│   [ Complete ]   [ Reject ]                  │
└──────────────────────────────────────────────┘
```

- **Complete** opens a small panel for your result payload (free-form
  JSON or a textbox; depends on the task type). What you submit
  becomes the task's `TaskResult.output`.
- **Reject** asks for a reason; the Hub records a failed result.

Either way the task vanishes from your pending list and the transcript
shows the round-trip.

### Channels (chat-like messages)

Below your task panel is a free-form message area. You can broadcast a
note to a channel that other participants can subscribe to. This is
useful for "hey, I need clarification on task X" without creating a
new task.

---

## I'm an admin — what's on my plate?

After the admin URL is opened with `?token=…` the first time, your
cookie is set and you don't need the token again. (You **do** want to
save the token somewhere safe — losing it means asking another admin
to invite you back, or resetting the workspace.)

The admin panel has four sections:

### 1. Pending applications

Remote agents that requested admission and are waiting. Each row shows:

```
app-id  agents=[claude-prod, gpt-prod]  caps=[draft,review]   [Approve] [Reject…]
```

- **Approve** — the application's agents are added to the registry.
  They become live participants immediately.
- **Reject** — asks for a reason. The agent's `connect()` call rejects
  with that message; SDK does not auto-retry.

### 2. Tasks

Every dispatched task with its current status: `pending` / `done` /
`failed` / `cancelled`. Filter buttons across the top. Failed rows have
a **Retry** button that re-dispatches the same payload (the result
links back to the original via `retryOf` in the transcript).

### 3. Dispatch

Three strategies:

| Strategy | When to use |
|---|---|
| `direct` | You know exactly who should do it (`recipient: 'alice'`) |
| `capability` | "Whoever has `draft` capability and is free-est" |
| `broadcast` | "First responder wins; the rest get cancelled" |

Free-form payload (JSON). Optional title and deadline.

### 4. Evaluate

After a task completes, you can attach an `Evaluation` (rating + free
comment). Stored on the transcript, no other side effects yet —
intended as the ground truth for future quality-tracking jobs.

### 5. Roster

The list of participants currently online (agents + humans), plus the
known-but-offline roster (workers who left, admins who logged out).
Useful to see who you can address tasks at.

### Inviting another admin

In the admin UI: **Invite admin** button. Enter the new admin's
display name. The page shows a one-time token + the URL to send them:

```
https://hub.example.com/admin?token=<NEW_HEX>
```

They open it, browser sets their cookie, they're in.

Programmatically (CLI):

```bash
curl -X POST -H "Authorization: Bearer <YOUR_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"displayName":"Carol"}' \
     https://hub.example.com/api/admin/admins
```

(See `docs/DEPLOY.md` for production details.)

### Revoking an admin

Same endpoint, DELETE:

```bash
curl -X DELETE -H "Authorization: Bearer <YOUR_TOKEN>" \
     https://hub.example.com/api/admin/admins/<id>
```

The server refuses if it would leave 0 admins, and refuses if you try
to revoke yourself (`logout` is the path for that).

---

## I'm the operator (server side) — how do I get the FIRST admin token?

Look at the host's stdout the first time it starts. It prints exactly
one line:

```
First-run admin URL (shown ONCE — save it):
  https://hub.example.com/admin?token=<HEX>
```

After that, the token is gone — only its SHA-256 hash is on disk. If
you lose it before opening it in a browser:

- If at least one other admin still has a working cookie: ask them to
  `POST /api/admin/admins` to mint you a fresh invite.
- If you're alone and locked out: stop the host, delete the workspace
  directory (`rm -rf /srv/aipehub-data`), restart. A new admin is
  minted. **All transcript history is lost** in this path — back up
  before you do it.

A future operator CLI will let you re-mint admins without the
filesystem nuke. Not built yet.

---

## Privacy expectations

- Everything you do in a room is in `transcript.jsonl` forever (append-
  only). Admins can read the whole thing.
- Worker identities are durable: leaving doesn't erase your past
  contributions, it just removes you from the live registry.
- If the workspace directory is backed up (and it should be), your
  history is in those backups too.

Public deployments should make this clear in their own ToS / room
description before workers join.
