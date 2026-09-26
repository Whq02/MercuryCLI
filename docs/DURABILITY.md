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
is recorded too; the damaged bytes stay in place until quarantined. A durable
file the build refuses to read — a roster, the daemon's control ledger, a
receipt ring, a journal file, or a row of this ledger itself — is named on
the same ledger as a refused event, its bytes left exactly in place; a
process names a file once, however many times it reads it.

## Deadlines and watchdogs

Long-running work is fenced by registered ceilings — the in-code registry
(`src/substrate/flagRegistry.ts`; rendered on demand to an untracked path) is
the complete index; the load-bearing ones:

- **Sub-agent inactivity** (`MERCURY_AGENT_IDLE_MINUTES`, default 15 minutes,
  `0` disables): a dispatched agent that produces no event at all — no stream
  delta, no tool use, no provider recovery notice — is stopped and settles as
  a typed stall naming its tool-use count, instead of a forever spinner.
  Declared provider recovery waits are honored. A stream that is alive on
  the wire counts as progress for this deadline and for a workflow agent's
  no-progress clock alike: the provider's heartbeat pings and the model's
  thinking are life even when nothing is painted, so only silence on the
  wire is a stall.
- **MCP call inactivity** (`MERCURY_MCP_CALL_IDLE_MINUTES`, default 10
  minutes, `0` disables): a `tools/call` yielding neither result nor progress
  notification settles as a typed stalled-call error and is cancelled on the
  wire; progress notifications keep a long call alive. The minutes are
  minutes of server silence: while the server's own question (a form or URL
  consent card) is waiting on the operator, the clock pauses, and the time
  spent answering never counts against the call — it resumes where it
  stopped the moment the answer lands.
- **Daemon run wall-clock** (`MERCURY_DAEMON_RUN_TIMEOUT_MS`, default 30
  minutes, read at fire time): a headless run past its cap gets SIGTERM, then
  SIGKILL after a five-second grace.
- **API connect budget** (`MERCURY_CONNECT_TIMEOUT_MS`, default 30000 ms): the
  transport's TCP/TLS connect timeout.

Mercury never stops or parks a runner for its memory use.

A repeated tool call is never refused, and by default no turn is ended for
repeating itself: the loop guard only reminds. A reminder rides into context
after the third, fifth and eighth identical call whose result is identical
too, counted across model responses — a response is judged once, after all
of its calls have settled, in the order the model issued them, so the calls
of one response count once whatever order they settle in, and a response
that mixes a new call into a repeating cycle breaks that cycle — and a cycle
of one to five calls repeated five times over with identical results draws a
stronger reminder on every detection; a call whose answer changed is
progress and resets the count, so a poll of a growing log is never a loop.
The response is Mercury's own unit, never an id the provider sent, and a
call a tool makes from inside its own execution (a Workshop cell, an Eval
re-entry) joins the response it runs in rather than opening one of its own,
taking its place under the call the model issued: the calls of one cell are
ordered by when each was started, not by when it settled, and a call comes
after every call made on its behalf, however deep the nesting and however
many there are, so nothing the model issued earlier in that response is
dropped or reordered. The operator sees each reminder as a recorded informational
row.
With `loopGuardStopEnabled: true` in settings, the second detection of the
same cycle of two to five calls ends the turn after the round it landed in
has settled: the model's context carries a `loop_stopped` note naming the
cycle in the order the calls were issued, the operator sees a warning row, a
headless run settles with the `error_loop_stopped` result, and a sub-agent
so ended reports a typed failure to its parent. A run of one identical call
is advisory on both roads, and the key is read live from the settings files.
A reply that chants — the same fifty-character stretch of prose ten times
over within a short span, code fences, lists, tables, headings, quotes and
dividers left out — is answered once with the same kind of reminder and the
model is asked to continue past it, whether the reply ended on its own or at
the output cap; a second chant lets the reply stand by default, and ends
the turn the same typed way under the key, with no chant handed on as a
sub-agent's report.
When a provider answers a request with no content at all, the chat says so
in a note and the request is sent again once, carrying a one-line note that
asks for the answer or the tool call, before the note stands as the turn's
end. On the OpenAI and Z.AI routes the note names the case. A
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
