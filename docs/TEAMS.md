# Teams

Mercury runs multi-agent work as teams: named agents the operator chats
with, a durable file-backed mailbox between them, one role registry shared with
in-session subagents, and boards to watch it all. Team state is plain files
under `<config home>/teams`, and every load-bearing team operation is
journaled (see [DURABILITY.md](DURABILITY.md)).

## Teams on disk

A team lives at `<config home>/teams/<team>/`: `config.json` holds the roster
(one truth, locked writers), `inboxes/` the per-agent mailboxes, and `dedup/`
the consumption ledgers. Task lists live beside it under
`<config home>/tasks/<team>/`, and every spawn appends an audit row to the
spawn ledger. Team creation and deletion are multi-record journal operations —
an interrupted create rolls forward or compensates at the next boot rather
than leaving a half-team behind.

## Named agents and spawning

`/teammates` is the Crew view: the focused session's sub-agents live — name,
model, status, tokens, elapsed — and the named, long-lived agents the daemon
keeps for the repository, one color-coded chat each, side by side. There is
no eager boot spawn: every named agent is an explicit, billed operator act
through the spawn wizard.

Named agents spawn on demand over the daemon's authed control socket. The RPC
carries only intent — a name and a model choice — and the daemon enforces the
floor server-side, where a client bug cannot bypass it:

- a validated model table that refuses Haiku-class models;
- permission mode `flow` — classifier-adjudicated asks — unless the operator's
  `MERCURY_DAEMON_PERMISSION_MODE` says otherwise;
- a read-only reconnaissance tool allowlist;
- child environment that prevents a named agent from fanning out workflow
  DAGs of its own;
- a name allowlist (`[a-z0-9-]` — the name reaches file paths and env);
- a spend guard: at most six live named agents, enforced at the spawn itself.

`MERCURY_CREW=0` disables the board and refuses the spawn RPC.

## The mailbox

Each (team, agent) pair has one inbox file:
`<teams>/<team>/inboxes/<agent>.json`, a bare JSON array of messages. Versioning is structural — every element is
validated on read, unknown fields are tolerated, and no field may become
required — because builds of different vintages run concurrently against the
same inboxes.

A send lands durably and exactly once: every message carries its own id and
sequence, and a crash between delivery and acknowledgement replays as a
no-op instead of a duplicate act. Operator messages to a named agent ride
this bus, and its replies ride its own SendMessage into the lead's inbox.

One delivery rule guards permission posture: inbound agent messages arriving
while the session runs in a bypass-permissions mode are held, visibly, until
the operator returns to a prompting mode (`MERCURY_INBOX_HOLD_BYPASS`); in
prompting modes messages deliver as always.

## Roles

Named-agent roles resolve through one resolver, whichever way the agent launches. A role is an agent definition — built-in,
custom, or from an extension — the same registry the in-session subagent tool
loads, and legacy type aliases decode to canonical ids, so a given role is the
same agent no matter how it was launched. `/agents` opens the Agent Studio for
building and tuning those definitions.

The living-crew directory (`/crew`) is the
canonical agent-identity registry: it binds agent principals, seat, roster and
crew forms, provider identities, and external adapter seats into stable crew
agent ids with role links. Identity derives from the founding binding, so a
rename, reconnect, or restart never mints a duplicate.

## Boards

`/team` opens the crew board on `/tasks` — the named agents, their phases and
handoffs. `/teammates` is the Crew view: the session's sub-agents live, and the
named agents' chats. `/crew` shows the directory with presence and external
seat attach/detach. `/sessions` manages this project's sessions, including
named-agent chats.

## The concourse

The Session Concourse — the board of the project you are in (its running
sessions and its parked chats), the hop into a row, the live tiles, NEEDS
YOU, the pings bell, the strip that walks only the screens that exist, and
how chats are born, focused, closed and brought back — is
[SESSIONS.md](SESSIONS.md)'s page. This section is the coordinator behind
the board.

Behind the board sits the switchboard coordinator: one terminal, the
operator, and their Mercury sessions running beside each other. The
coordinator launches, watches, messages, pauses, resumes, queues and
reconciles sessions and answers questions from the repository it sits on; it
never does a session's work or reaches inside one, and every verb settles as
a receipt row the operator sees. The coordinator surface is experimental and
says so itself on the board: trust receipts, never assumed success.
