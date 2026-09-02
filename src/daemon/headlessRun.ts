// Shared isolated-headless-child runner for the Mercury daemon.
//
// Both the cron path (main.ts onFireTask) and the control-socket dispatch path
// (roster.ts → TaskRoster.dispatch's headless fallback) run a prompt the same
// way: a full, sandboxed `node <mercury.mjs> -p "<prompt>"` child with its own
// lifecycle. This module owns that single implementation so the two callers can
// never drift. (Lifted verbatim from the prior inline copy in main.ts.)
//
// SAFETY: each run is an isolated child — a crashing or hanging run cannot take
// the daemon down. stdout is captured (the `-p` final text); stdin/stderr are not
// shared with the daemon's terminal. A per-run wall-clock cap SIGKILLs a child
// that overruns. This never rejects: a spawn failure resolves with empty output
// and a non-zero code so the caller's loop-stop / breaker bookkeeping advances.

import { spawn, type ChildProcess } from 'node:child_process'
import { logForDebugging } from '../utils/debug.js'
import { enforceSubagentModelFloor } from '../utils/model/modelFloor.js'
import { killProcessGroup } from '../utils/processGroup.js'
import {
  assertSpawnCwd,
  recordSpawn,
  recordSpawnExit,
  spawnedByStamp,
  SPAWNED_BY_ENV,
} from '../utils/spawnLedger.js'
import { WORKER_PARENT_PID_ENV } from './workerParentWatch.js'
import { flagEnv, flagPair, flagSpellings, stampFlagOnEnv } from '../substrate/flagRegistry.js'
import { decodePermissionModeSpelling } from '../types/permissions.js'
import { LIVE_ROLE_ENV_VARS, RETIRED_SEAT_ENV_VARS } from '../utils/workerRole.js'

/**
 * Every role env var a worker may carry — a process runs as AT MOST one
 * (assertSingleRole). The roster lives in utils/workerRole.ts (the one
 * owner every role-hygiene seam reads): the live concourse-worker marker
 * plus the RETIRED seat markers — nothing in the tree sets those any more,
 * but an operator shell (or a stale supervisor env) still can, so the
 * spawn-time strip and the supervisor scrub keep sweeping the spellings —
 * a retired marker must never ride into a child and resurrect a persona.
 */
export { ALL_ROLE_ENV_VARS } from '../utils/workerRole.js'
/** The swept role SPELLINGS: the live roles resolve through the registry
 *  (flagSpellings — the registration check for free); the retired five sweep
 *  by their literal canonical spellings — their registry rows died with the
 *  estate, and flagSpellings THROWS on an unregistered name (the every-turn
 *  outage class). */
function sweptRoleSpellings(): string[] {
  return [...LIVE_ROLE_ENV_VARS.flatMap(flagSpellings), ...RETIRED_SEAT_ENV_VARS]
}

/**
 * The CREW identity pair is deliberately NOT in ALL_ROLE_ENV_VARS. MERCURY_CREW
 * is dual-polarity ('0' = the operator's default-on kill, '1' = the
 * daemon-stamped child role marker isCrewRole reads), so the uniform
 * delete-if-set strip above would ERASE an operator's =0 kill; and
 * MERCURY_CREW_AGENT (the teammate's own name) is stamped via buildCrewSpec
 * extraEnv, which merges BEFORE the child sanitize — listing it there would
 * delete the crew child's own stamp. This helper strips only the ROLE FORM
 * (='1') plus the name marker; a '0' always survives. Applied at all three
 * role-hygiene seams: the supervisor scrub, the cron-child clone, and the
 * long-lived child sanitize (non-crew specs only — a leaked crew identity on
 * another seat would hijack its replies to team-lead, because
 * workerReplyTarget's crew branch wins).
 */
export function stripCrewRolePair(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = []
  // Both spellings: the role form ='1' on
  // EITHER spelling strips BOTH; a '0' kill survives on both.
  const crewSpellings = flagSpellings('MERCURY_CREW')
  if (crewSpellings.some(v => env[v] === '1')) {
    for (const v of crewSpellings) {
      if (env[v] === '1') {
        delete env[v]
        removed.push(v)
      }
    }
  }
  for (const v of flagSpellings('MERCURY_CREW_AGENT')) {
    if (env[v] !== undefined) {
      delete env[v]
      removed.push(v)
    }
  }
  return removed
}

/**
 * Strip EVERY role env var from the supervisor's own process.env (mutates it).
 * The daemon supervisor must NEVER run AS a role: a role-tagged foreground
 * (a daemon-hosted worker's own marker) that spawns the detached
 * daemon leaks its role into the inherited env, so an unrelated scheduled task
 * could adopt that persona (the role gates key off
 * these vars). This is the SINGLE-STRIP source — call ONCE at daemon startup; the
 * cron one-shot path (runTaskHeadless) ALSO clones+strips per run (belt-and-
 * suspenders, cloneEnvWithoutRoles), so a leak after startup can't reach a child.
 * Harmless to buildStreamJsonInvocation, which clones process.env and re-stamps
 * the intended role on its own copy. Returns the vars actually removed (for the
 * startup log + the regression proof). Defaults to process.env; an explicit env
 * arg makes it unit-testable.
 */
export function scrubSupervisorRoleEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = []
  for (const v of sweptRoleSpellings()) {
    if (env[v] !== undefined) {
      delete env[v]
      removed.push(v)
    }
  }
  removed.push(...stripCrewRolePair(env))
  return removed
}

/** Default max wall-clock a single headless run may take before the daemon kills it. */
export const RUN_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Resolve the per-run wall-clock cap. Reads MERCURY_DAEMON_RUN_TIMEOUT_MS at call
 * time so an operator can lengthen the leash for a big legitimate workflow fire,
 * or tighten it for an away-run, WITHOUT a rebuild — mirroring every other daemon
 * caps (MERCURY_DAEMON_MAX_INFLIGHT, the breaker knobs).
 * Non-numeric, zero, or negative values fall back to the 30m default (a cap of 0
 * would SIGKILL every run instantly, never what an operator wants).
 */
export function getRunTimeoutMs(): number {
  const raw = flagEnv('MERCURY_DAEMON_RUN_TIMEOUT_MS')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RUN_TIMEOUT_MS
}

/** Default SIGTERM→SIGKILL grace after a run overruns its wall-clock cap. */
export const RUN_KILL_GRACE_MS = 5_000

/**
 * Resolve the SIGTERM→SIGKILL grace window for a timed-out run. On the cap the
 * daemon now sends SIGTERM first (a chance for the child to flush its final text
 * and exit cleanly), then SIGKILLs only what is still alive after this grace —
 * instead of the old hard SIGKILL with zero flush window. Env-tunable
 * (MERCURY_DAEMON_KILL_GRACE_MS) like every other daemon brake; non-numeric or
 * negative falls back to the 5s default. 0 is honored (immediate hard kill — the
 * old behavior) for an operator who wants no grace.
 */
export function getRunKillGraceMs(): number {
  const raw = flagEnv('MERCURY_DAEMON_KILL_GRACE_MS')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RUN_KILL_GRACE_MS
}

/** Default cap on the captured-stdout tail buffer per in-flight headless run. */
export const RUN_MAXBUF_BYTES = 1024 * 1024

/**
 * Resolve the captured-stdout cap (bytes). `-p` only needs the FINAL text, which
 * lives at the TAIL, but a chatty 30m run streams verbose tool/turn output through
 * stdout — without a cap one in-flight dispatch grows an unbounded heap string. We
 * keep only the trailing N bytes (front-trimmed as it grows), so a long run is
 * memory-bounded and the captured result is still loss-safe. Env-tunable
 * (MERCURY_DAEMON_RUN_MAXBUF); non-numeric, zero, or negative falls back to 1MB.
 */
export function getRunMaxBufBytes(): number {
  const raw = flagEnv('MERCURY_DAEMON_RUN_MAXBUF')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RUN_MAXBUF_BYTES
}

// ── Child permission posture ─────────────────────────────────────────────────
// A daemon child runs `-p` (print mode) with NO permission prompt available:
// getCanUseToolFn's no-prompt path resolves every 'ask' to a terminal deny
// (src/cli/print.ts:4297), so a child booted with no mode flag lands in
// 'default' mode where anything not rule-allowed silently dies — and the
// supervisor cannot tell a policy block from a real tool failure. Every OTHER
// agent spawn seam already stamps a posture (AgentTool subagents default
// 'implement', AgentTool.tsx:581; teammate spawns inherit the parent's mode,
// spawnMultiAgent.ts:236); the daemon seam was the one spawn path with none.

/** Default posture stamped onto every daemon-spawned child: 'flow' — the
 *  classifier-adjudicated mode (flow ≠ bypass; genuinely risky commands still
 *  deny and the child escalates). Was implement mode (the AgentTool-subagent
 *  mirror) until: in a `-p` child every 'ask' terminal-denies, so
 *  implement left SHELL dead ("This command requires approval" on the
 *  first real bash), which the seats fixed for themselves with a
 *  spec-level flow posture while cron one-shots kept the dead floor.
 *  Operator directive: workers get shell like the lead. The classifier's
 *  availability fault is covered by the fallback
 *  chain (MERCURY_CLASSIFIER_FALLBACK) + the recon allowlist floor;
 *  MERCURY_DAEMON_PERMISSION_MODE=implement restores the old posture. */
export const HEADLESS_PERMISSION_MODE_DEFAULT = 'flow'

/** Operator-selectable child postures (MERCURY_DAEMON_PERMISSION_MODE). The
 *  interactive-only modes are deliberately absent: 'strategy' needs a human
 *  to approve the plan —
 *  neither can progress inside a headless child. */
export const HEADLESS_PERMISSION_MODES = [
  'default',
  'implement',
  'flow',
  'dontAsk',
  'sovereign',
] as const
export type HeadlessPermissionMode = (typeof HEADLESS_PERMISSION_MODES)[number]

/**
 * Resolve the child permission posture. Reads MERCURY_DAEMON_PERMISSION_MODE
 * at call time (live, like every other daemon knob) so the operator can
 * retune without restarting the daemon; an unknown value falls back to the
 * default rather than spawning a child in an unintended posture. A retired
 * mode spelling (an operator shell profile from before the mode-identity
 * migration) decodes through the bounded alias before validation.
 *
 * `specDefault` (optional) is a per-spec posture a spawn seam declares for
 * its OWN children (the crew seats declare 'flow' — see buildCrewSpec). An
 * operator-set env ALWAYS wins over it (the ask-the-operator model rule's
 * permission analog: an explicit operator knob is never silently overridden);
 * the spec default applies only when the env is unset/invalid.
 */
export function getHeadlessPermissionMode(
  specDefault?: HeadlessPermissionMode,
): HeadlessPermissionMode {
  const fallback = specDefault ?? HEADLESS_PERMISSION_MODE_DEFAULT
  const raw = (flagEnv('MERCURY_DAEMON_PERMISSION_MODE') ?? '').trim()
  if (!raw) return fallback
  const decoded = decodePermissionModeSpelling(raw)
  if ((HEADLESS_PERMISSION_MODES as readonly string[]).includes(decoded)) {
    return decoded as HeadlessPermissionMode
  }
  logForDebugging(
    `[daemon] MERCURY_DAEMON_PERMISSION_MODE=${raw} is not one of ${HEADLESS_PERMISSION_MODES.join('|')} — using ${fallback}`,
  )
  return fallback
}

/**
 * The argv words for a posture. Mirrors spawnMultiAgent's buildInheritedCliFlags
 * mapping: bypass is spelled --dangerously-skip-permissions (the CLI's canonical
 * bypass arm), 'default' is the bare boot (no flag — the pre-fix argv, so
 * the operator can restore the old behavior exactly), everything else is
 * --permission-mode <mode>.
 */
export function headlessPermissionArgv(
  mode: HeadlessPermissionMode = getHeadlessPermissionMode(),
): string[] {
  if (mode === 'default') return []
  if (mode === 'sovereign') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode]
}

/**
 * Kill a headless child AND its grandchildren in one shot. runTaskHeadless spawns
 * its `-p` child with `detached:true`, so the child is a process-GROUP LEADER (its
 * pid == its pgid); a `node mercury.mjs -p …` run that itself spawns helpers (a
 * sub-`-p`, ripgrep, a build) lands them in that same group. `process.kill(-pid,
 * sig)` signals the WHOLE group, so a timeout / manual kill can't orphan the
 * grandchildren — the bug was signalling only the direct child, leaving detached
 * descendants burning tokens/CPU after the cap. Falls back to a direct `child.kill`
 * if the group send throws (pid already gone, or never became a leader).
 * Best-effort; never throws.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // delegate to the ONE cross-platform group-kill owner
  // (utils/processGroup.ts) — identical POSIX group-signal fast path, plus
  // the taskkill/ps-walk fallback this local copy lacked on win32.
  killProcessGroup(child, signal)
}

/**
 * A CLONE of process.env with EVERY role var stripped — the env a cron `-p` child
 * inherits. Belt-and-suspenders for the supervisor scrub (scrubSupervisorRoleEnv,
 * called once at daemon startup): even if a role leaked in AFTER startup, or the
 * single-strip ordering ever regressed, a per-run clone can never hand a scheduled
 * task a stray persona (the role gates key off these
 * vars). Mirrors the exact strip buildStreamJsonInvocation does on its own clone,
 * so the two spawn paths are identically role-safe.
 */
function cloneEnvWithoutRoles(): NodeJS.ProcessEnv {
  // child-env law: raw base by design — the child IS Mercury (a headless
  // worker running the session's own auth); the sweeps below curate it.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of sweptRoleSpellings()) {
    delete env[v]
  }
  stripCrewRolePair(env)
  // Never-Haiku floor on the daemon's OWN autonomous -p runs (P11 refute pass,
  // scope-boundary gap): a cron/dispatch-fired headless child inherits
  // ANTHROPIC_MODEL and runs its ENTIRE main loop on it — including a
  // schedule-fired workflow's orchestrator. If that inherited value is Haiku-tier
  // on Mercury, floor it so the daemon never autonomously runs delegated work
  // on Haiku. Bare-stamp / non-Haiku runs: unchanged. (The child's OWN subagents are
  // already floored downstream; this covers the loop itself.)
  if (env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = enforceSubagentModelFloor(env.ANTHROPIC_MODEL, 'daemon:headless-loop')
  }
  // Brief is AWAY-scoped: a daemon-fired run is
  // the genuine away context — the operator is not watching a terminal, so
  // SendUserMessage (brief view + notifications) is the delivery channel.
  // The explicit opt-in survives the -p non-interactive denial in
  // isBriefEntitled; daemon-hosted worker roles stay denied by their own
  // entitlement terms. Interactive desktop sessions no longer default in.
  env.MERCURY_BRIEF ??= '1'
  return env
}

/** Captured result of one headless run. */
export interface HeadlessResult {
  stdout: string
  code: number | null
  /** Best-effort pid of the spawned child (undefined if spawn failed). */
  pid?: number
  /**
   * True ONLY when the run was SIGKILLed because it overran the per-run
   * wall-clock cap (the timer path below). A normal close — even one that exits
   * via a signal with `code === null` — leaves this absent. Lets the breaker feed
   * tell a legitimately-long TIMEOUT apart from a genuine crash (both close with
   * `code === null`) so a long task does not trip the global fleet brake.
   */
  timedOut?: boolean
}

/** What a headless run needs: a prompt, an id (for logs), and a cwd. */
export interface HeadlessSpec {
  id: string
  prompt: string
  /** Per-spec posture under the operator env — same semantics as the
   *  long-lived StreamJsonChildSpec field (worker-shell floor:
   *  the one-shot honors what the stream-json seam honors). */
  permissionMode?: HeadlessPermissionMode
  /** Permission ALLOW rules passed as `--allowedTools` — the read-only recon
   *  floor that survives a classifier fault. Absent/empty ⇒ no flag. */
  allowedTools?: readonly string[]
  /** Scheduled resume: resume this session (`-p --resume <id>`) instead
   *  of running the prompt in a fresh transcript — the dead-session revival
   *  path (an in-session fire never reaches this spawn). Absent ⇒ no flag. */
  resumeSessionId?: string
}

/**
 * Workflow interop: build the headless prompt for a dispatched run. When the
 * task carries a `workflow` name, the run is dispatched AS that dynamic workflow
 * via the `/<workflow> <args>` slash-command form (deterministic — the saved
 * `.mercury/workflows/<name>.js` program, not a model paraphrase of free text),
 * with the task's own `prompt` passed through as the workflow argument string.
 * Otherwise the prompt is the free-form text, unchanged (default behaviour).
 *
 * The leading slash is what routes a `-p` headless run through the workflow
 * command surface (getWorkflowCommands → Workflow tool). A name that already
 * begins with `/` is used as-is so an operator can also schedule a raw slash
 * command. Never throws; an empty/whitespace workflow name falls back to prompt.
 */
export function buildHeadlessPrompt(task: {
  prompt: string
  workflow?: string
}): string {
  const wf = (task.workflow ?? '').trim()
  if (!wf) return task.prompt
  const cmd = wf.startsWith('/') ? wf : `/${wf}`
  const args = (task.prompt ?? '').trim()
  return args ? `${cmd} ${args}` : cmd
}

/**
 * Best-effort path to the running Mercury executable. process.argv[1] is the
 * invoked entry (the bundled mercury.mjs); process.execPath is the node binary
 * that runs it. Spawning `node mercury.mjs -p …` reuses the exact running build.
 */
export function getSelfInvocation(): { node: string; script: string } {
  return { node: process.execPath, script: process.argv[1] || '' }
}

// ── The long-lived stream-json child ─────────────────────────────────────────
// Unlike runTaskHeadless (a one-shot isolated run with a 30m SIGKILL cap), a
// crew teammate or a session worker is a LONG-LIVED supervised process:
// bidirectional stream-json over stdin/stdout, a per-role CLONED env, and NO
// wall-clock kill timer (the roster supervises + respawns it instead).

export interface StreamJsonChildSpec {
  /** Canonical model id, e.g. 'claude-sonnet-5' or 'claude-fable-5[1m]'.
   *  Passed BOTH as --model and ANTHROPIC_MODEL. */
  model: string
  /** Effort floor, e.g. 'high'. Set as MERCURY_EFFORT_LEVEL so
   *  resolveAppliedEffort does not downgrade it. */
  effort: string
  /** The compiled role wrapper pack, passed via --append-system-prompt. */
  appendSystemPrompt: string
  /** The role env var to set to '1' in the CLONED child env. */
  role:
    | 'MERCURY_CREW'
    | 'MERCURY_CONCOURSE_WORKER'
  /** Mailbox identity triplet (validated together by the CLI). */
  agentName: string
  agentId: string
  teamName?: string
  cwd?: string
  /** Optional extra vars stamped into the CLONED child env (e.g. the crew
   *  teammate's own name). Spec-carried so supervisor respawns keep it.
   *  Overlaid BEFORE the model/effort/swarm stamps and the role
   *  sanitize+stamp — it can never override those. */
  extraEnv?: Readonly<Record<string, string>>
  /** Per-spec permission-posture DEFAULT for this child. An operator-set
   *  MERCURY_DAEMON_PERMISSION_MODE always wins; this applies only when that
   *  env is unset/invalid (see getHeadlessPermissionMode). Spec-carried so
   *  supervisor respawns keep it. Absent ⇒ the global daemon default. */
  permissionMode?: HeadlessPermissionMode
  /** Permission ALLOW rules passed as `--allowedTools` (e.g. the crew seats'
   *  read-only recon set) — rule-allowed calls short-circuit before any
   *  classifier, so routine recon survives a classifier fault. Spec-carried
   *  so supervisor respawns keep it. Absent/empty ⇒ no flag (default argv). */
  allowedTools?: readonly string[]
  /** Extra argv appended verbatim to the invocation (the
   *  Concourse worker's `--session-id <minted>` pin). Spec-carried so
   *  supervisor respawns keep it — unless respawnExtraArgv overrides. */
  extraArgv?: readonly string[]
  /** Respawn-only argv REPLACING extraArgv when the roster's capped-backoff
   *  path rebuilds the invocation ({respawn: true}). The Concourse worker's
   *  first boot pins `--session-id X`; an existing transcript refuses that
   *  flag (exit 1, "already in use"), so its respawn rides `--resume X` —
   *  the SAME durable session continues instead of a crash-loop. */
  respawnExtraArgv?: readonly string[]
  /** (the greeting sever): omit the mailbox identity
   *  triplet from argv entirely — the child boots as a PLAIN operator
   *  session. No --team-name/--agent-name/--agent-id ⇒ no dynamic team
   *  context ⇒ the first-turn team_context teammate attachment can never
   *  arm — the wrapper-greeting reproduction chain dies at the spawn seam,
   *  and the transcript carries no teamName (operator-classed; the board
   *  hides its own rows via boardHomedSessionIds). The spec's agentName /
   *  agentId remain roster/record labels only. */
  plainIdentity?: boolean
  /** Env vars deleted from the CLONED child env (both spellings — callers
   *  build the list via flagSpellings) BEFORE the extraEnv overlay. The
   *  Concourse worker's CH-01 hygiene: a session worker must never inherit
   *  the supervisor's session room, splash handoff, alt-hold, launch id or
   *  guest room token. Spec-carried so supervisor respawns keep it. */
  stripEnv?: readonly string[]
}

/**
 * Build the (node, script, argv, env) for a long-lived stream-json child WITHOUT
 * spawning — pure, so the invocation can be asserted in tests. The env is a
 * CLONE of process.env (never mutate the supervisor) with the per-role model /
 * effort / swarm / role vars overlaid.
 */
export function buildStreamJsonInvocation(
  spec: StreamJsonChildSpec,
  opts?: { respawn?: boolean },
): {
  node: string
  script: string
  argv: string[]
  env: NodeJS.ProcessEnv
} {
  const { node, script } = getSelfInvocation()
  // Never-Haiku floor on the daemon spawn seam (belt-and-suspenders under the
  // seat-slot validation upstream): whatever reaches an AUTONOMOUS long-lived
  // child spec — env override, reconfigure patch, future caller — cannot spawn
  // Haiku on the fork. Fires on the spec value itself so respawns (which
  // re-read ll.spec) are covered too. A CONCOURSE session worker is the
  // OPERATOR'S OWN chat: it runs the model the operator chose (the economy
  // tier included — the admission validated the session arm already), so the
  // autonomous floor never rewrites it.
  const model =
    spec.role === 'MERCURY_CONCOURSE_WORKER'
      ? spec.model
      : enforceSubagentModelFloor(spec.model, `daemon:${spec.agentName}`)
  const teamName = spec.teamName ?? 'default'
  const argv = [
    script,
    '-p',
    // print.ts refuses `--output-format=stream-json` without --verbose (exits 1
    // on the first output line). A long-lived worker streams JSON events,
    // so --verbose is mandatory or the child dies before running a single turn.
    '--verbose',
    // Permission posture — without this the child boots 'default' mode and
    // every 'ask' terminal-denies silently (no prompt exists in print mode).
    // Per-spec default (crew seats: 'flow') under the operator env override.
    ...headlessPermissionArgv(getHeadlessPermissionMode(spec.permissionMode)),
    // Spec-carried allow rules (the worker recon set): rule-allowed ⇒ no ask ⇒ no
    // classifier dependency for the read-only core.
    ...(spec.allowedTools && spec.allowedTools.length > 0
      ? ['--allowedTools', ...spec.allowedTools]
      : []),
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--model',
    model,
    '--append-system-prompt',
    spec.appendSystemPrompt,
    // W0.2: a plain-identity child gets NO mailbox triplet — the teammate
    // attachment chain (team_context) structurally cannot arm.
    ...(spec.plainIdentity
      ? []
      : [
          '--team-name',
          teamName,
          '--agent-name',
          spec.agentName,
          '--agent-id',
          spec.agentId,
        ]),
    // Spec-carried argv extension; a respawn substitutes respawnExtraArgv
    // when declared (the Concourse --session-id → --resume asymmetry).
    ...((opts?.respawn ? (spec.respawnExtraArgv ?? spec.extraArgv) : spec.extraArgv) ?? []),
  ]
  // child-env law: raw base by design — the spawned child IS Mercury (the
  // strips below curate launch/terminal identity, never its own auth).
  const inherited: NodeJS.ProcessEnv = { ...process.env }
  // Spec-declared launch/terminal identity the child must NEVER inherit
  // (CH-01: the Concourse worker's session room / splash handoff /
  // alt-hold / launch id / guest token) — deleted from the clone BEFORE the
  // extraEnv overlay, so a spec's own stamps still land.
  for (const v of spec.stripEnv ?? []) {
    delete inherited[v]
  }
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    // Per-spec additions (the workflows posture) overlay BEFORE the load-bearing
    // stamps below, so extraEnv can never override the floored model, the effort
    // pin, or swarm enablement — and the role sanitize+stamp after this block
    // keeps role hygiene authoritative regardless of what extraEnv carries.
    ...(spec.extraEnv ?? {}),
    ANTHROPIC_MODEL: model,
    MERCURY_EFFORT_LEVEL: spec.effort,
    ...flagPair('MERCURY_SWARMS', '1'),
  }
  // Sanitize ALL role vars from the inherited clone before stamping the target
  // role. A child spawned from a role-tagged parent (a daemon-hosted worker
  // spawning its own) would otherwise inherit it
  // alongside its own role → assertSingleRole() sees both → throws → crash-loop.
  // Exactly one role var must ever be present in the child env.
  for (const v of sweptRoleSpellings()) {
    delete env[v]
  }
  // Crew identity pair — same hygiene for every NON-crew child (a leaked crew
  // role would hijack its SendMessage reply target to team-lead); the crew
  // child's own name stamp (extraEnv, merged above) must survive, and its role
  // marker is stamped just below.
  if (spec.role !== 'MERCURY_CREW') {
    stripCrewRolePair(env)
  }
  stampFlagOnEnv(env, spec.role, '1')
  return { node, script, argv, env }
}

/**
 * Spawn the long-lived stream-json child. stdio is ['pipe','pipe','inherit'] so
 * the supervisor can WRITE user-frames to stdin (the reply path, Task 4.2),
 * CAPTURE stdout (the stream-json events), and share stderr with the daemon's
 * terminal. NO RUN_TIMEOUT_MS / SIGKILL timer is armed — the child is supervised
 * + respawned by the roster, not wall-clock-killed.
 */
export function spawnStreamJsonChild(
  spec: StreamJsonChildSpec,
  opts?: { respawn?: boolean },
): {
  child: ChildProcess
  argv: string[]
  env: NodeJS.ProcessEnv
} {
  const { node, script, argv, env } = buildStreamJsonInvocation(spec, opts)
  if (!script) {
    logForDebugging('[daemon] cannot resolve self executable; stream-json child not spawned')
  }
  // Stamp the spawning daemon's pid so the worker can SELF-EXIT the instant this
  // daemon dies (workerParentWatch — the mirror of the daemon's ownerWatch). The
  // stdin pipe already EOFs the worker on daemon death, but only after the current
  // turn; this poll catches it within ~8s regardless of turn state ⇒ no orphaned
  // worker / usage burn. Only daemon-spawned workers carry this env.
  stampFlagOnEnv(env, WORKER_PARENT_PID_ENV, String(process.pid))
  // Spawn provenance: stamp WHO spawned this child
  // and ledger the spawn — attribution must be a lookup, not forensics.
  stampFlagOnEnv(env, SPAWNED_BY_ENV, spawnedByStamp(`daemon-${spec.role.toLowerCase()}`, spec.agentId))
  recordSpawn({
    kind: 'long-lived',
    id: spec.agentId,
    cwd: spec.cwd ?? process.cwd(),
    role: spec.role,
  })
  logForDebugging(
    `[daemon] spawning long-lived stream-json child role=${spec.role} model=${spec.model} effort=${spec.effort}`,
  )
  const child = spawn(node, argv, {
    cwd: spec.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    // win32: never a visible console per worker.
    windowsHide: true,
    env,
  })
  return { child, argv, env }
}

/**
 * Run one prompt headlessly in an isolated child. Resolves with captured stdout
 * (the `-p` final text), exit code, and the child pid. Never rejects.
 *
 * `onChild` (optional) receives the spawned ChildProcess synchronously so a
 * caller (the roster) can record the pid and wire a kill handle before the run
 * settles.
 */
export function runTaskHeadless(
  spec: HeadlessSpec,
  dir: string,
  onChild?: (child: ChildProcess) => void,
  timeoutMs: number = getRunTimeoutMs(),
): Promise<HeadlessResult> {
  return new Promise(resolvePromise => {
    const { node, script } = getSelfInvocation()
    if (!script) {
      logForDebugging(
        `[daemon] cannot resolve self executable; skipping run ${spec.id}`,
      )
      resolvePromise({ stdout: '', code: 1 })
      return
    }

    logForDebugging(`[daemon] running ${spec.id} headlessly`)
    let child: ChildProcess
    try {
      // Stamp the daemon's pid so the one-shot worker (a) self-exits on daemon
      // death (workerParentWatch, matching the long-lived path) and (b) floors
      // its OWN main-loop model on Mercury if settings.model resolves Haiku
      // (getMainLoopModel keys the floor on this env). cloneEnvWithoutRoles is a
      // fresh clone, so this never leaks back to the daemon.
      const oneShotEnv = cloneEnvWithoutRoles()
      stampFlagOnEnv(oneShotEnv, WORKER_PARENT_PID_ENV, String(process.pid))
      stampFlagOnEnv(oneShotEnv, SPAWNED_BY_ENV, spawnedByStamp('daemon-fire', spec.id))
      // Dead-cwd refusal: the one-shot path was the
      // only spawn chokepoint WITHOUT the gate — a scheduled job whose cwd was
      // deleted would ledger a normal row then ENOENT-fail every scheduled
      // fire with no 'refused' row. Same contract as roster/teammate spawns.
      const cwdGate = assertSpawnCwd(dir)
      if (!cwdGate.ok) {
        recordSpawn({ kind: 'headless-refused', id: spec.id, cwd: dir, reason: cwdGate.reason })
        logForDebugging(`[daemon] REFUSED headless fire for ${spec.id}: ${cwdGate.reason}`)
        resolvePromise({ stdout: `refused: ${cwdGate.reason}`, code: 1 })
        return
      }
      recordSpawn({ kind: 'headless', id: spec.id, cwd: dir })
      // Same permission posture as the long-lived seam (see the block above
      // buildStreamJsonInvocation) — a cron one-shot in bare 'default' mode
      // silently terminal-denies every 'ask' in print mode. Honors the SAME
      // spec fields as buildStreamJsonInvocation (worker-shell
      // floor): spec.permissionMode under the operator env, and
      // spec.allowedTools as the classifier-fault-immune recon floor — the
      // one-shot was the last daemon worker without them.
      child = spawn(
        node,
        [
          script,
          '-p',
          ...headlessPermissionArgv(getHeadlessPermissionMode(spec.permissionMode)),
          ...(spec.allowedTools && spec.allowedTools.length > 0
            ? ['--allowedTools', ...spec.allowedTools]
            : []),
          // Scheduled resume one-shot: revive the dead session rather than open a
          // fresh transcript (print.ts validates `-p --resume <session-id>`).
          ...(spec.resumeSessionId ? ['--resume', spec.resumeSessionId] : []),
          spec.prompt,
        ],
        {
        cwd: dir,
        // detached → the child leads its OWN process group, so a timeout / manual
        // kill can SIGTERM/SIGKILL the whole group (killProcessTree) and reap the
        // `-p` run's grandchildren instead of orphaning them. We never unref it —
        // the daemon still awaits its close (this is supervised, not fire-and-forget).
        detached: true,
        // win32: a detached console child pops its own visible window unless
        // hidden; no-op elsewhere.
        windowsHide: true,
        // Isolated run: never share stdio with the daemon's own terminal — capture
        // stdout, swallow the rest.
        stdio: ['ignore', 'pipe', 'ignore'],
        // Per-run CLONE with all role vars stripped + the worker-parent stamp
        // (belt over the startup scrub so a leaked role never becomes a cron
        // child's persona; the stamp arms self-exit + the worker-loop floor).
        env: oneShotEnv,
      })
    } catch (e) {
      logForDebugging(`[daemon] spawn failed for ${spec.id}: ${e}`)
      // The spawn row above already landed — close the pair honestly.
      recordSpawnExit({
        kind: 'headless',
        event: 'exit',
        id: spec.id,
        code: 1,
        outcome: 'spawn-failed',
        reason: String(e),
      })
      resolvePromise({ stdout: '', code: 1 })
      return
    }

    onChild?.(child)

    let stdout = ''
    const maxBuf = getRunMaxBufBytes()
    let settled = false
    // Set TRUE the instant the wall-clock cap fires (before any SIGTERM/SIGKILL),
    // so the resolved HeadlessResult carries `timedOut` regardless of whether the
    // child then flushed-and-exited within grace (real code) or was SIGKILLed
    // (code null). Lets the breaker feed tell a legitimately-long TIMEOUT apart
    // from a genuine crash (both can close with code===null).
    let wasTimedOut = false
    // The SIGTERM→SIGKILL grace timer (armed on the cap); cleared on settle so a
    // child that exits within grace never takes a stray late SIGKILL.
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (killCloseBackstop) clearTimeout(killCloseBackstop)
      // pair the spawn row with an exit row at the ONE settle chokepoint
      // (covers cron fires AND control dispatches — both ride this function).
      recordSpawnExit({
        kind: 'headless',
        event: 'exit',
        id: spec.id,
        pid: child.pid,
        code,
        outcome: wasTimedOut ? 'timeout' : code === 0 ? 'ok' : code === null ? 'killed' : 'failed',
      })
      resolvePromise({
        stdout,
        code,
        pid: child.pid,
        ...(wasTimedOut ? { timedOut: true } : {}),
      })
    }

    //  (ST-8): after a SIGKILL, settle from the child's `close`
    // (stdout flushed between SIGTERM and death is still delivered) — the
    // old immediate finish(null) preempted the close handler and dropped it.
    // The backstop covers a close that never lands (a stray inherited pipe
    // holding the streams open) so a dispatch can't hang on a dead child.
    const KILL_CLOSE_BACKSTOP_MS = 2_000
    let killCloseBackstop: ReturnType<typeof setTimeout> | undefined
    const finishOnCloseWithBackstop = () => {
      if (settled || killCloseBackstop) return
      killCloseBackstop = setTimeout(() => finish(null), KILL_CLOSE_BACKSTOP_MS)
      killCloseBackstop.unref?.()
    }

    // Wall-clock cap. SIGTERM the child's GROUP first (a chance to flush its final
    // text + exit clean), then SIGKILL the group only if it is still alive after the
    // grace. killProcessTree signals the whole process group (the child is detached,
    // so it leads one) ⇒ a `-p` run's grandchildren are reaped too, never orphaned.
    // We do NOT finish() on the SIGTERM: the child's own `close` resolves with its
    // REAL exit code if it exits in time; otherwise the grace timer SIGKILLs + finishes.
    const timer = setTimeout(() => {
      wasTimedOut = true
      const graceMs = getRunKillGraceMs()
      logForDebugging(
        `[daemon] run ${spec.id} timed out — SIGTERM (SIGKILL in ${graceMs}ms if still alive)`,
      )
      killProcessTree(child, 'SIGTERM')
      if (graceMs <= 0) {
        // No grace requested — hard-kill the group immediately; `close`
        // settles with the flushed output (backstop-bounded, ST-8).
        killProcessTree(child, 'SIGKILL')
        finishOnCloseWithBackstop()
        return
      }
      killTimer = setTimeout(() => {
        logForDebugging(`[daemon] run ${spec.id} grace elapsed — SIGKILL`)
        killProcessTree(child, 'SIGKILL')
        finishOnCloseWithBackstop()
      }, graceMs)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', d => {
      stdout += d
      // Bound the captured buffer: the `-p` final text is at the TAIL, so keep only
      // the trailing maxBuf chars (front-trimmed) — one chatty 30m run can't grow an
      // unbounded heap string per in-flight dispatch.
      if (stdout.length > maxBuf) stdout = stdout.slice(-maxBuf)
    })
    child.on('error', e => {
      logForDebugging(`[daemon] child error for ${spec.id}: ${e}`)
      finish(1)
    })
    child.on('close', code => finish(code))
  })
}
