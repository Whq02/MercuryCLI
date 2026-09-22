# Durability

Mercury's durable state — teams, tasks, mailboxes, run records, daemon
schedules, stores, change sets — is written so that an abrupt process death
(kill, crash, power loss) never leaves torn bytes, silently lost commits, or
views that disagree with disk.

## The publication floor

Every production "write a complete file atomically" routes through one
primitive: an exclusively-created same-directory temp two writers can never
share, the complete bytes flushed before an atomic rename, and the parent
directory flushed after it on platforms that support it. Readers see
old-complete or new-complete, never torn; a failed publication removes its
own temp and preserves the prior committed destination; failures are typed
with the failing phase.

On Windows only, transient rename errors from the
antivirus/indexer/open-handle class retry briefly on the same prepared
temp. `MERCURY_DURABLE_FSYNC=0` opts out of the flush barriers for slow
disks. Stale temps left by a death are swept — age-gated, so a concurrent
writer's live temp is never touched.

## Multi-record operations

A durable operation spanning more than one record (a team plus its task
root; a run outcome plus its artifact) is journaled with an idempotency
key: the operation is durably prepared before its first external step,
every step is idempotent, and completion is durably marked before the
operation is exposed as complete. Startup recovery rolls incomplete
operations forward or compensates them — recovery itself survives a second
death — and re-running the same operation returns the prior committed
result, never duplicated work. The journal is plain local files,
inspectable with `cat`.

## Boot reconciliation

One reconciliation pass runs at interactive and daemon boot, before any
view is built: stale temps swept, incomplete journal operations rolled
forward or compensated, dead task bodies reclaimed, leader projections
rebuilt, and damaged-store quarantine counts surfaced. The pass never
throws — per-domain failures land in a typed report that `/run`, `/team`,
and `/health` read — it is idempotent, and its sweeps are bounded: a
pathological home degrades to partial coverage, recorded, never a hang.

## Damaged stores: quarantine, never silent

A mutation must never silently proceed from an empty default over the only
damaged copy of a store. Before a fail-open store mutates past unreadable
bytes, the bytes are preserved as a bounded, clearly-named quarantine copy
beside the store, and the recovery is recorded in an append-only ledger
that `/health` and the UI surface — including whether the mutation resumed
from the last committed value or from empty. A read that degraded to empty
is recorded too; the damaged bytes stay in place until quarantined. A ledger
row the build cannot read as an event is skipped and counted nowhere.

## Deadlines and watchdogs

Long-running work is fenced by registered ceilings — the in-code registry
(`src/substrate/flagRegistry.ts`; rendered on demand to an untracked path) is
the complete index; the load-bearing ones:

- **Sub-agent inactivity** (`MERCURY_AGENT_IDLE_MINUTES`, default 15 minutes,
  `0` disables): a dispatched agent that produces no event at all — no stream
  delta, no tool use, no provider recovery notice — is stopped and settles as
  a typed stall naming its tool-use count, instead of a forever spinner.
  Declared provider recovery waits are honored.
- **MCP call inactivity** (`MERCURY_MCP_CALL_IDLE_MINUTES`, default 10
  minutes, `0` disables): a `tools/call` yielding neither result nor progress
  notification settles as a typed stalled-call error and is cancelled on the
  wire; progress notifications keep a long call alive.
- **Daemon run wall-clock** (`MERCURY_DAEMON_RUN_TIMEOUT_MS`, default 30
  minutes, read at fire time): a headless run past its cap gets SIGTERM, then
  SIGKILL after a five-second grace.
- **API connect budget** (`MERCURY_CONNECT_TIMEOUT_MS`, default 30000 ms): the
  transport's TCP/TLS connect timeout.

Mercury never stops or parks a runner for its memory use.

A session is never stopped for repeating a tool call, whether the answer
changes or not: Mercury keeps no count of a turn's repeated tool calls
against its progress, no call is refused for repeating an earlier one, and
no watcher ends a turn on a repeated call or a repeated result.
When a provider answers a request with no content at all, the chat says so
in a note and the same request is sent again once before the note stands as
the turn's end. On the OpenAI and Z.AI routes the note names the case. A
response the provider completed with no words is silence: the note says so
and the turn ends there, with no second request. A response the provider
stopped at its own output cap before any words names the cap, and the
reasoning tokens spent by the provider's count when the provider states
them, and the turn ends there, with no second request. Only a stream that
ends with nothing at all is sent again once.

A run is never recorded complete while a task it filed stays open, on a
print or worker seat exactly as in the cockpit: the stop asks for the open
work instead, and the record names how many deliverables remain. A record
that reads complete with open deliverables (one written by an earlier build)
is reopened as continuing on its next fold, with the open count named, never
left as a receipt that contradicts its own task list.

## Resource bounds

Every long-lived durable structure has a declared writer, a bound and a
reaper, and a reap records what it preserved.
