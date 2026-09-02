# The health certificate

`/health` (alias `/doctor`) certifies the install: runtime, settings, and
channel checked live, rolled into one verdict. The same certificate runs
headless as `mercury health` / `mercury doctor`. Configured MCP servers are
validated without being started.

The certificate holds three properties:

1. **Evidence-backed** — every check carries a mandatory `evidence` string
   naming the artifact, probe, or value consulted. No evidence means the check
   reads `unknown`, never a silent pass.
2. **Freshness-honest** — evidence that predates what it certifies (a gate
   verdict from an older HEAD, a certificate from before a resume) reads
   `stale`.
3. **A verdict** — `certified`, `caution`, or `fault`, with fixes ranked
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
| `router-fast` | ROUTER |
| `architecture-fast` | ARCHITECTURE PRIMITIVES |

CREW & DAEMONS carries the `Store isolation` check, which reads the config
home's harness records by Mercury's own fingerprint: a daemon-plane record carrying no Mercury
fingerprint was written by another tool and is reported with its evidence
line — named when the signature table recognizes the writer (the agent CLIs
and SDKs it knows), reported as unrecognized otherwise. An older Mercury's
records are Mercury's own; version variance is never foreignness. The check's remedy archives the foreign records into a
dated directory inside the home — reversible, nothing deleted.

## Fixes

Checks can carry an executable remedy — `{plan, apply, verify}` — and a remedy
is offered only for statuses that assert something is wrong (`fail`, `warn`,
`stale`); `ok`, `info`, `off`, and `unknown` rows never expose apply. The fix engine
applies a remedy and then re-probes with `verify()` — the outcome the operator
sees is the verification, never apply's self-report. Every applied fix writes an
evolution-ledger row, so the improvement history is auditable.

Consent: in the interactive panel a fix goes through a consent card, and
destructive remedies render the warning register. Headless, `mercury health
--fix` applies safe remedies and requires `--yes` for destructive ones.
`--only <id>` limits any headless form — the plain report, `--json`, `--fix`
— to one check.

## The doctor JSON

`mercury doctor --json` prints the certificate as one JSON document
(`certSchema` 2). A piped or redirected run is not this host's interactive
terminal: the terminal-profile row reads as environmental and never raises
the verdict. The document carries:

- `verdict`, `ranAt`, `version`, `durationMs`, `depth`;
- `head` — repo state at issue time: `{sha, branch, dirty}`, null fields when
  not a git repository;
- `nodeRuntime` — the runtime contract: `{observed, label, range, verdict}`
  with verdict `supported`, `too-old`, `unqualified-major`, `prerelease`, or
  `invalid`;
- `sections[]` — each `{id, title, checks[]}`, each check
  `{id, label, probe, depth, durationMs, evidence, evidenceAt, status}`;
- `readiness[]` — the capability-readiness rows: each
  `{id, kind, label, state, detail, source, lastCheckedAt, latencyMs}`, with
  kind one of `tool`, `mcp`, `lane`, `engine`, `extension`, `skill`, and state
  one of `ready`, `configured`, `degraded`, `disabled`, `unavailable`.

## Artifacts

The doctor state root is the project (`<project>/.mercury/`;
`MERCURY_DOCTOR_STATE_DIR` overrides it as the hermetic-isolation seam):

- `doctor/last-cert.json` — an atomic, best-effort summary written after each
  certificate; the certificate chip in the session chrome folds it in (a
  summary older than a day reads stale), and resume honesty reads it too.
  Skipped entirely when the certificate surface is gated off.
- `doctor/last-preflight.json` — the boot preflight's summary. The preflight
  (`MERCURY_BOOT_PREFLIGHT`) runs a cheap subset of `/health` after the UI
  mounts and notifies only on a fault; it is not a certificate and never
  writes `last-cert.json`.
- `gate/verdict.json` — written by the local verification pool (`bun run
  verify`); the PROOFS section reads it as evidence and
  reports it `stale` when it predates the current HEAD.

## Gates

The certificate surface, the fix engine, and the boot preflight are default-on
and individually killable: `MERCURY_DOCTOR_CERT=0` restores a plain
install-diagnostics screen with no certificate and no artifact writes,
`MERCURY_DOCTOR_FIX=0` makes `/health` diagnose-only (no remedy offered
anywhere), and `MERCURY_BOOT_PREFLIGHT=0` skips the boot preflight entirely.
All three rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path).
