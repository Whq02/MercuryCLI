# The health certificate

`/health` certifies the install: runtime, settings, and channel checked
live, rolled into one verdict. The same certificate runs headless as
`mercury health`.

Configured MCP servers are validated without being started.

The certificate holds three properties:

1. **Evidence-backed:** every check carries a mandatory `evidence` string
   naming the artifact, probe, or value consulted. No evidence means the check
   reads `unknown`, never a silent pass.
2. **Freshness-honest:** evidence that predates what it certifies (a gate
   verdict from an older HEAD, a certificate from before a resume) reads
   `stale`.
3. **A verdict:** `certified`, `caution`, or `fault`, with fixes ranked
   worst-first.

The report is strictly read-only against the harness: it consults gate helpers,
snapshots, small local artifacts, and OS metrics. It never runs a session,
never mutates state, and never echoes a credential; its only write is the
last-certificate summary described below.

## Checks and the verdict

A check's status is one of `ok`, `warn`, `fail`, `stale`, `unknown`, `off`, or
`info`; its probe kind is `functional` or `configuration`, and its depth `fast`
or `deep` (`--deep` runs the deep inventory). The roll-up rule: any `fail`
makes the verdict `fault`; otherwise any `warn`, `stale`, or `unknown` makes it
`caution`; otherwise `certified`. `off` and `info` are neutral by doctrine and
never raise the verdict.

A fast run certifies these sections (section id · title):

| id | title |
| --- | --- |
| `identity` | IDENTITY |
| `proofs` | PROOFS |
| `git` | GIT |
| `crew` | CREW & DAEMONS |
| `memory` | MEMORY & CONTEXT |
| `settings` | SETTINGS & FLAGS |
| `auth` | AUTH |
| `interface` | INTERFACE |
| `runtime` | RUNTIME |
| `durability` | DURABILITY |
| `native-ownership` | TERMINAL RUNTIME |
| `profile` | PROFILE |
| `coding-loop-fast` | CODING LOOP |
| `flux` | TERMINAL FLUIDITY |
| `tool-capability-fast` | TOOL CAPABILITY |
| `architecture-fast` | ARCHITECTURE PRIMITIVES |

### Client contract

IDENTITY's `Client contract` row shows the client version Mercury presents on
the Claude sign-in and where it came from: the built-in version and the day
it was last checked, a newer number learned from the registry with the day
it was learned, or the override. It names a failed or unsaved registry read.
When the provider refuses the presented version as too old, Mercury learns
the newer number once and retries the refused request; the refusal is
reported with the version required, what Mercury presented and
what the registry read did. `MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version>`
raises the presented version without a rebuild and wins over every other
source; `MERCURY_DISABLE_NONESSENTIAL_TRAFFIC` keeps the registry reads dark.

IDENTITY's `Refused models` row sits beside `Client contract`: a model refused
for a minimum client version, a subscription tier or a model-specific 403/404
stays visible with the same sentence as the chat and picker. The row warns
with the model, credential door, cause and time since the refusal; expanding
it shows the sentence and remedy. A successful request for that model on
that door clears the refusal, and changing the presented client version
clears a minimum-version refusal. A refusal for a model the service does not
serve is a notice: it warns for an hour after it was seen and then stays as
an `info` record; a minimum-version or tier refusal keeps warning until the
client or the plan moves. While a refusal warns, `mercury health --fix --only
model-refusals` (or the fix engine in the panel) forgets the records; a
refusal that recurs is recorded again. The `Preserved thinking` row follows
the same law: a recorded drop warns for an hour and for the session it
happened in, then reads `info`, and its warn carries a forget remedy. With no
recorded refusal the row reads `info`: `no model refused on any door in this
session`. The observations are
shared by the runner, picker and the health check through the current credential home's
`model-refusals` directory, so a separate health check can read a recorded refusal
too; it never makes a provider request to discover one.

AUTH's `Anthropic` row checks the claude.ai sign-in before it answers, and
the `OpenAI` row does the same for a ChatGPT subscription: a sign-in whose
access token has not reached its expiry is read locally and makes no request;
one past its expiry is renewed through its refresh grant, the one request the
check makes, and the row reads `renewed on this check`; a grant the provider
refuses marks the sign-in expired, the row warns with `sign-in expired` and
its fix is the same line the chat shows (`/logins <family>` reconnects). The
same check runs once when Mercury opens, so an expired sign-in shows on the
boot screen's Logins row (`<Family> sign-in expired`) before a first prompt is
sent. When a prompt does meet an expired sign-in, its words come back to the
composer under the error line and are sent again on their own once `/logins`
lands a credential (or `/model` moves the session to a family that is signed
in) while the composer still holds them unchanged.

INTERFACE's `Browser` row names the executable the Browser tool resolves:
Chrome for Testing with its build id and managed cache path, or your
explicit executable pin. Installed Chrome, Edge, Chromium and Brave apps are
discovered for information only; the tool never selects them automatically.
With no managed browser, the row reads `info` and names `/browser install`,
the one-time consented Chrome for Testing download; the consent step names the
exact download size for the build it plans (the current stable is about 185 MB
and unpacks to roughly twice that on disk), and `/browser status` shows the
size a build takes once installed.
A broken pin names itself instead of falling through to another browser.
This is a configuration check: it reads the cache and paths without launching
a browser, probing its version, or downloading anything. The tool's status
and `/browser status` show the same resolution and the discovered apps.

RUNTIME's `Device headroom` row is joined by `Box lock`: the coordination
directory of the box lock (`MERCURY_BOX_LOCK_DIR`), the slots held and by
whom, and the tickets waiting (or the plain word that no lock directory is
named). The resource `mercury://health/box` gives an agent the same reading
live. The memory figure on the box row is the last sample the process took,
with the clock it was taken at and its source (`vm_stat`, `meminfo`, the
Windows counter, or the runtime's own free figure before any sample); a
facts answer never takes a sample, and `mercury://health/box` takes a fresh
one.

RUNTIME's `Session kind` row reads the focused session's kind from its daemon
record. An oculus session belongs to a screen; its questions wait until you
answer them or end the session, including while you switch to another chat.
A headless session is unattended. Its unanswered asks expire on their clock,
and an unanswered question ends the run as blocked. A record without a kind
reads as headless until the session is resumed from the screen. With no chat
open the row says so. The row is `info` and leaves the verdict unchanged.
[SESSIONS.md](SESSIONS.md) defines the two kinds.

TOOL CAPABILITY carries the `Tools withheld` check: every built-in tool kept
out of the model's catalog because a machine dependency is absent (a debug
adapter for Debug, a Godot executable for Godot, the desktop driver for
Computer, the search binary for Grep and Glob), with why and the remedy;
the withheld tools also appear in `readiness[]` as `tool:withheld:<name>`
rows. With nothing withheld the row says so and names what it checks. The
row waits for the debug adapter's toolchain probes to answer, so it never
names the Debug tool as withheld for a probe still in flight. TOOL CAPABILITY
also carries `Local media` (`media`): `off` while `media.enabled` is off, `ok`
with the media folder path when the folder and runtime binary exist, and
`warn` when the folder or runtime is missing (`/imagesetup` is the fix) or
when `media.imageModel` or `media.videoModel` were written into Mercury's
settings instead of `<media.root>/config.json` ([MEDIA.md](MEDIA.md)).

SETTINGS & FLAGS carries the `Env overrides` check: the registered flags
set in the environment, with Mercury's own stamps and the boot's saved
defaults named apart from your overrides. Each override names the
registered switch, its value and its kind; unset switches use their defaults.

AUTH carries the `Model lists` row: for all 19 provider families Mercury
carries typed model ids for (Anthropic, OpenAI, Z.AI, Moonshot, DeepSeek,
xAI, Meta, Gemini, Hugging Face, Mistral, Nous, OpenCode Zen, MiniMax,
Together AI, Cohere, Groq, Cerebras, Fireworks AI, Qwen), whether each
typed id is still served by the live model list the product has already read
for that family's signed-in source. The row never fetches: it reads the
catalogue already fetched by `/model`, `/logins` or a chat naming the family.
A family nothing has asked about reads `no list read in this process —
/model or a chat naming the family reads it · <n> typed ids not judged`,
and a family without a credential reads `<Family> · no credential · <n> typed
ids not judged`. When a list has been read, the family's line names the
credential door, the served and not-served counts, and `list from <age>`; a
failed read names the failed door, the endpoint's reason and the age. The
evidence line counts served and unserved ids, then `lists read <n> of 19`
across all 19 families.
The detail names one line per family and, beneath a family whose list lacks a typed id,
the ids it lacks. The row reads `ok` when every typed id a read list can
judge is served, `warn` when a read list lacks one, `info` when no list has
been read in this process or no signed-in family has a live list, and
`unknown` only when a cached list could not be read. A headless
`mercury health` is a fresh process, so its row reads what that process has
read, which is nothing, and never rolls the certificate to caution for a list
nobody asked for; the release-day check
(`bun scripts/ops/check-typed-model-ids.ts`) fetches every list live and
uses the same comparison.

AUTH carries the `Provider slots` row (`provider-slots`): every engine family
either reads configured or names one of its honest unavailable codes
(`no-account:`, `no-api-key:`, `no-credential:`, `not-configured:`,
`no-server:` and the like), and the Anthropic classes resolve to their
own family's models; a row that cannot say which is a `fail` naming the
broken invariant.

AUTH also carries the `Web search` row (`web-search-door`): it reports the
search cascade available to the session's model, including native provider
search (`Anthropic web search (native, session account)` or `OpenAI web search
(native, session account)`), stored Brave or Tavily keys, the official APIs,
configured SearXNG instances (joined only when
`MERCURY_SEARCH_SEARXNG_INSTANCES` configures at least one permitted instance;
otherwise noted as `no metasearch instance configured`), and keyless DuckDuckGo
page scraping (on by default). When no search door opens for the model (no
native search, no Brave/Tavily key, no SearXNG instance, and DuckDuckGo page
scraping turned off in `/config` or with `MERCURY_SEARCH_KEYLESS=0`), the row
reads `info` (`no door opens for <model>`) and names `BRAVE_API_KEY` (or
`TAVILY_API_KEY`) and `/config` to turn DuckDuckGo page scraping back on.

CREW & DAEMONS carries the `Store isolation` check, which reads the config
home's harness records by Mercury's own fingerprint: a daemon-plane record carrying no Mercury
fingerprint was written by another tool and is reported with its evidence
line: named when the signature table recognizes the writer (the agent CLIs
and SDKs it knows), reported as unrecognized otherwise. An older Mercury's
records are Mercury's own; version variance is never foreignness. The check's remedy archives the foreign records into a
dated directory inside the home (reversible, nothing deleted).

CREW & DAEMONS also carries `Mercury processes`, the process sweep: it lists
Mercury's own processes on this box and classes each one by Mercury's own
facts (`running`, `stale`, `cannot end`, `not ours`), never by a parent pid. A
process is Mercury's own when its command line names Mercury and its
executable is node, bun or the launcher; on Linux the executable is read
from the command line or the kernel's own link to the binary, because the
process table's command name there is the main thread's name. A
window is read by its own registration (`<config home>/processes/`, a pid, a
birth token and a heartbeat the window writes and clears at exit) and by
whether a live shell still owns its terminal; a daemon by its own
record, its owner, its live sessions, schedules and persistence; a runner by
the daemon's roster and its session's seat. Any live fact keeps a process
running; an explicit or persistent daemon is never stale; a process whose
facts cannot be read cannot be ended and says why. The row's evidence is the
four counts; its trail lists each stale and cannot-end process as
`pid <pid> · <terminal or no terminal> · <age> · <reason>`. The sweep runs
read-only at every daemon boot and window boot, and those two boots are the
only reads that record a census (under `<config home>/processes/census.json`)
and prune the registrations of windows that are provably gone; the health check's
row and `mercury health processes` read the processes live and write nothing
under the config home, and an ending records what it did in that census.
Nothing is ever ended on its own. The row's destructive remedy shows exactly that list and asks `End these <N>
stale processes?`; it asks each process to end itself first (the daemon
re-checks identity and staleness inside itself before its shutdown or kill),
then a termination signal, a bounded wait (`MERCURY_PROCESS_SWEEP_WAIT_MS`;
the closure allowance before a window, runner or daemon may read stale is
the park drain, `MERCURY_SESSION_PARK_DRAIN_MINUTES`),
then a kill signal, re-reading identity and staleness before each step (a daemon that does not answer the end request for its own plane refuses it: nothing is sent), and
reports `Ended <N> stale processes; <N> could not be ended; <N> left running`;
a survivor of the kill signal reads `cannot end — needs a reboot`. Headless,
`mercury health processes` prints the same listing as JSON and `--end-stale`
ends the stale ones it lists; `mercury health --fix --yes` applies this
destructive remedy like any other. A process table that cannot be read whole
is an incomplete census: nothing is listed, nothing is pruned, nothing is
ended. On Windows the sweep reads the processes through the system's own
management interface and ends a reviewed stale process on request, one process
at a time; the Windows guide describes the read and the stop.

## Fixes

Checks can carry an executable remedy (`{plan, apply, verify}`), and a remedy
is offered only for statuses that assert something is wrong (`fail`, `warn`,
`stale`); `ok`, `info`, `off`, and `unknown` rows never expose apply. The fix engine
applies a remedy and then re-probes with `verify()`: the outcome you
see is the verification, never apply's self-report. Every applied fix writes an
evolution-ledger row, so the improvement history is auditable.

Consent: in the interactive panel a fix goes through a consent card, and
destructive remedies render the warning register. Headless, `mercury health
--fix` applies safe remedies and requires `--yes` for destructive ones.
`--only <id>` limits any headless form (the plain report, `--json`, `--fix`)
to one check.

## The health JSON

`mercury health --json` prints the certificate as one JSON document
(`certSchema` 2). A piped or redirected run is not this host's interactive
terminal: the terminal-profile row reads as environmental and never raises
the verdict. The document carries:

- `verdict`, `ranAt`, `version`, `durationMs`, `depth`;
- `head`: repo state at issue time (`{sha, branch, dirty}`), null fields when
  not a git repository;
- `nodeRuntime`: the runtime contract (`{observed, label, range, verdict}`)
  with verdict `supported`, `too-old`, `unqualified-major`, `prerelease`, or
  `invalid`;
- `sections[]`: each `{id, title, checks[]}`, each check
  `{id, label, probe, depth, durationMs, evidence, evidenceAt, status}`;
- `readiness[]`: the capability-readiness rows, each
  `{id, kind, label, state, detail, source, lastCheckedAt, latencyMs}`, with
  kind one of `tool`, `mcp`, `lane`, `engine`, `extension`, `skill`, and state
  one of `ready`, `configured`, `degraded`, `disabled`, `unavailable`.

## Artifacts

Certificate files live beside the project's transcripts under
`<config home>/projects/<project>/`, in the `health` store.
`MERCURY_HEALTH_STATE_DIR` selects the project root used to resolve the
store; it is not a direct certificate-directory override:

- `health/last-cert.json`: an atomic, best-effort summary written after each
  certificate; the certificate chip in the session chrome folds it in (a
  summary older than a day reads stale), and resume honesty reads it too.
  A fast certificate written after a deep one keeps the deep-only rows'
  last reading (each with its own time) and the worse verdict of the two, so
  a payload fault found at depth is never hidden behind a later fast
  caution; the next deep run replaces them. Skipped entirely when the
  certificate surface is gated off.
- `health/last-preflight.json`: the boot preflight's summary. The preflight
  (`MERCURY_BOOT_PREFLIGHT`) runs a cheap subset of `/health` after the UI
  mounts and notifies only on a fault; it is not a certificate and never
  writes `last-cert.json`.
- `gate/verdict.json`: written by the local verification pool (`bun run
  verify`); the PROOFS section reads it as evidence and
  reports it `stale` when it predates the current HEAD.

## Gates

The certificate surface, the fix engine, and the boot preflight are default-on
and individually killable: `MERCURY_HEALTH_CERT=0` restores a plain
install-diagnostics screen with no certificate and no artifact writes,
`MERCURY_HEALTH_FIX=0` makes `/health` diagnose-only (no remedy offered
anywhere), and `MERCURY_BOOT_PREFLIGHT=0` skips the boot preflight entirely.
All three rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path).
