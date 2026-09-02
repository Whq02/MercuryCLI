// ============================================================================
//  harnessMap — Mercury surface-map self-knowledge.
// ----------------------------------------------------------------------------
//  The runtime-posture block (#62) tells the model what POSTURE this process
//  boots with; this block tells it WHERE Mercury's native surfaces live, so a
//  session routes to the right board/tool instead of guessing or answering
//  from generic-CLI priors ("I have no notes system", "no debugger here").
//  Observed gap (operator,): the prompt named the identity but
//  never the map — nothing told the model /note, /workflows,
//  /capabilities, the LSP/Debug hands, or /health exist.
//
//  HONESTY RULES (same contract as runtimePosture.ts):
//  - PER-LINE GATING: a surface line renders ONLY if its backing gate is ON
//    at boot — an OFF flag must not be advertised (stale-claim class).
//  - Computed ONCE per process and memoized (prompt-cache byte-stability).
//  - MERCURY_HARNESS_MAP=0 ⇒ null ⇒ byte-identical absence.
//  - Facts only, one line per surface, no exhortation (orientation is
//    prompt-appropriate; behavior rules belong to gates).
// ============================================================================

import { crewEnabled } from '../../daemon/crewSpawn.js'
import { experienceCardsEnabled } from '../../memdir/experienceCards.js'
import { mnemeEnabled } from '../../memdir/mnemeGates.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { isDapToolCatalogEnabled, reachableDapAdapterKeys } from '../../services/dap/dapClient.js'
import { mercuryGodotEnabled } from '../../services/lsp/godotLane.js'
import { mercuryUnityEnabled } from '../../services/ide/unityProject.js'
import { mercuryBlenderEnabled } from '../../services/ide/blenderProject.js'
import { mercuryAsepriteEnabled } from '../../services/aseprite/asepriteApp.js'
import { isLspToolCatalogEnabled } from '../../services/lsp/mercuryLsp.js'
import { themisActive, themisLevel } from '../../substrate/themis/level.js'
import { isSaturnSchedulingEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { dynamicWorkflowsEnabled } from '../../tools/WorkflowTool/workflowEnablement.js'
import { getVulcanHarnessMapLine } from '../vulcan/vulcanGates.js'
import { isSessionMarkedNonInteractive } from './runtimePosture.js'
import { healthCertEnabled } from '../healthReport.js'
import { isTabulaEnabled } from '../tabula/tabulaGates.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** House substrate-gate shape: default-ON, `=0` opts out. INTERACTIVE-only
 *  (product-study r2: headless/daemon children were being told to use
 *  operator-only boards — the headless-brief-leak class; a `-p` one-shot or
 *  a daemon worker has no operator to route to /tabula). */
export function harnessMapEnabled(): boolean {
  if (flagEnv('MERCURY_HARNESS_MAP') === '0') return false
  // The house seam (runtimePosture.ts): the HEADLESS ENTRYPOINT marks the
  // process — default interactive, no TTY sniffing (`-p` in a real terminal
  // still has TTY stdio; bootstrap STATE.isInteractive defaults FALSE until
  // main() and would have nulled the map in every bun-run proof).
  if (isSessionMarkedNonInteractive()) return false
  return true
}

let memo: string | null | undefined

// gate reads (slice 12) — wrapped so a load failure degrades to an
// absent line, never a broken map (the map must survive any one subsystem).
function workshopEnabledSafe(): boolean {
  try {
    return (require('../../services/workshop/contracts.js') as typeof import('../../services/workshop/contracts.js')).workshopEnabled()
  } catch {
    return false
  }
}
function servicesEnabledSafe(): boolean {
  try {
    return (require('../../services/projectServices/contracts.js') as typeof import('../../services/projectServices/contracts.js')).servicesEnabled()
  } catch {
    return false
  }
}
function refsEnabledSafe(): boolean {
  try {
    return (require('../../services/resources/contracts.js') as typeof import('../../services/resources/contracts.js')).mercuryRefsEnabled()
  } catch {
    return false
  }
}
function projectIntelEnabledSafe(): boolean {
  try {
    return (require('../../services/projectIntel/contracts.js') as typeof import('../../services/projectIntel/contracts.js')).projectIntelEnabled()
  } catch {
    return false
  }
}
function lanesEnabledSafe(): boolean {
  try {
    return (require('../../services/contextLanes/lanes.js') as typeof import('../../services/contextLanes/lanes.js')).lanesEnabled()
  } catch {
    return false
  }
}
function counselArmedSafe(): boolean {
  try {
    return (require('../../services/counsel/counsel.js') as typeof import('../../services/counsel/counsel.js')).counselEnabled()
  } catch {
    return false
  }
}
/** The SAME mounted predicate the tool roster uses (LSPTool.isEnabled →
 *  isLspToolMounted): the map line keys on it so the LSP surface is never
 *  advertised while the roster withholds the tool (uncovered project, failed
 *  init, no server configured). A configured server in error keeps the tool
 *  — and this line — mounted, so serverStatus can say what failed (FN-015
 *  rank 56). The per-turn delta announces a later connect. */
function lspConnectedSafe(): boolean {
  try {
    return (require('../../services/lsp/manager.js') as typeof import('../../services/lsp/manager.js')).isLspToolMounted()
  } catch {
    return false
  }
}
/** The Debug half's honesty gate: the catalog alone advertised "a real DAP
 *  debugger" on machines where every launch refuses (no adapter backing at
 *  all — the advertised-while-absent class). Reachability is the CHEAP
 *  census (fs/memo/30s-cache only — this runs in the per-turn delta); a
 *  census failure claims nothing. */
function dapReachableSafe(): boolean {
  try {
    return reachableDapAdapterKeys().length > 0
  } catch {
    return false
  }
}

/** The LIVE per-surface lines (uncached — gates re-read on every call). The
 *  memoized prompt block below freezes these at boot for cache stability;
 *  the mid-session DELTA attachment (getHarnessMapDelta) re-computes them
 *  each turn and announces changes (#182: /invite arm, a THEMIS
 *  level flip — an armed opt-in the model does not know about is an
 *  unreachable feature). */
export function computeHarnessMapLines(): string[] {
  const lines: Array<string | null> = [
    `- Discovery: /help lists commands; /capabilities is the live capability matrix for THIS build${healthCertEnabled() ? '; /health runs the evidence-backed health certificate' : ''}.`,
    // Unconditional (task #9): bundled skills are compiled into every Mercury
    // build — no gate to mirror. Routes provider-API work off stale training
    // priors onto the bundled reference.
    '- Provider-API reference: the bundled provider-apis skill holds the current model ids, request shapes, streaming, tool-call, and caching law for every provider API Mercury speaks (Anthropic Messages, OpenAI Responses, OpenAI-compatible chat-completions) — invoke it instead of answering from training memory; bundled Mercury skills supersede same-named external/legacy skills (claude-api is superseded).',
    isAutoMemoryEnabled() || experienceCardsEnabled()
      ? '- Persistent memory: auto-memory (your memory directory) persists across sessions; /cards reviews experience cards. Save durable lessons there, not in ad-hoc files.'
      : null,
    isTabulaEnabled()
      ? '- Project notepad (TABULA): /note <text> captures a note for this project; /tabula opens the board. Notes survive /clear — prefer them for cross-session reminders.'
      : null,
    dynamicWorkflowsEnabled()
      ? '- Deterministic multi-agent orchestration: the Workflow tool; /workflows is its board → run → inspector.'
      : null,
    isSaturnSchedulingEnabled()
      ? '- Scheduled/recurring runs (SATURN): the CronCreate · CronList · CronDelete tools; /saturn is the board (a births one by hand).'
      : null,
    // The LSP half keys on catalog AND connection — the roster's own gate
    // (LSPTool.isEnabled → isLspToolMounted) withholds the tool in every
    // uncovered project, and the map must never advertise an OFF surface.
    // The Debug half keys on catalog AND adapter reachability: the tool
    // launches adapters on demand, but a machine where every launch refuses
    // (no adapter backing at all) must read the honest idle line below, not
    // "a real DAP debugger" (the advertised-while-absent class).
    (isLspToolCatalogEnabled() && lspConnectedSafe()) || (isDapToolCatalogEnabled() && dapReachableSafe())
      ? `- Code intelligence is native: ${[isLspToolCatalogEnabled() && lspConnectedSafe() ? 'the LSP tool (diagnostics, rename, code actions, pathRename file moves, fixDiagnostic)' : null, isDapToolCatalogEnabled() && dapReachableSafe() ? 'the Debug tool (a real DAP debugger: breakpoints, stepping, evaluate)' : null].filter(Boolean).join(' and ')} — prefer them over grep-and-rerun for symbol and runtime-state work.`
      : null,
    // The honest install line (facts only): the Debug tool is cataloged but
    // no adapter on this machine can serve a launch — say so, with the
    // one-line arm remedy per lane, instead of a silent absence.
    isDapToolCatalogEnabled() && !dapReachableSafe()
      ? '- The Debug tool is cataloged but NO debug adapter is reachable on this machine — a launch will refuse with the per-adapter remedy. Arm one: Python `pip install debugpy` (or a build carrying the vendored adapter) · native `xcode-select --install` (lldb-dap) or gdb 14+ · JS: unpack js-debug to ~/.js-debug · Go `go install github.com/go-delve/delve/cmd/dlv@latest`.'
      : null,
 // coding-loop surfaces (slice 12): each line self-gates.
    workshopEnabledSafe()
      ? '- Persistent analysis cells: the Workshop tool runs js/ts/py cells with RETAINED state across calls (mercury.tool/agent/inspect compose normal tools inside cells) — prefer it for multi-step data work over re-running Bash pipelines.'
      : null,
    servicesEnabledSafe()
      ? '- Long-lived project processes: the Service tool (start/wait/logs/stop with readiness conditions + cursored logs) — use it instead of backgrounded Bash for servers, watch builds, and local APIs; services are addressable as mercury://service/<name>.'
      : null,
    refsEnabledSafe()
      ? "- The work graph is addressable: mercury://<kind>/<id> refs (runs, receipts, tasks, teams, workflows, services, lanes, artifacts, health) resolve through the Inspect tool — follow refs instead of replaying transcripts."
      : null,
    // Project intelligence: the snapshot + working-set surfaces.
    projectIntelEnabledSafe() && refsEnabledSafe()
      ? '- Project intelligence is native: mercury://project/current resolves the generation-keyed snapshot (modules · changes · knowledge · checks), ?child=context&q=<task> assembles the EXPLAINED task working set, ?child=impact&q=<path> projects established impact, ?child=split&q=<a> || <b> proposes a two-operator division; a context_capsule reminder in your context IS the current working set (evidence-ranked refs — dereference to read); mercury://transcript/session|agent gives bounded concise transcript views; /orient pin|drop corrects the working set.'
      : null,
    lanesEnabledSafe()
      ? '- Bounded side questions: /branch <goal> forks a side lane with an explicit boundary; /branch return <answer> records a typed handoff and flips back; /branches lists. Prefer a lane over derailing the main thread for a genuine tangent.'
      : null,
    counselArmedSafe()
      ? '- Counsel is ARMED: a bounded second look reviews observed change receipts (/counsel run — manual; auto delivery lands cards at turn boundaries). Treat its findings as evidence review, not authority.'
      : null,
    // Opt-in lanes announce themselves when armed (#182: an armed opt-in the
    // model does not know about is an unreachable feature).
    mercuryGodotEnabled()
      ? "- Godot lanes are ARMED: in a Godot project (project.godot at the root), the editor GDScript LSP and the Debug tool's `godot` DAP adapter are live over the loopback bridge — use them for GDScript symbol and runtime work."
      : null,
    getVulcanHarnessMapLine(),
    mercuryUnityEnabled()
      ? "- Unity lanes are ARMED: in a Unity project (Assets/ + ProjectSettings/ at the root), .cs gets the C# LSP lane (PATH server) and the Debug tool's `unity` adapter attaches to the RUNNING editor; the `Unity` tool drives that editor over the loopback bridge (play mode, scenes, hierarchy, console, Test Runner) once the bridge package is installed (op:\"unity_bridge_install\"); headless test/build launch profiles are operator-run (the tool prints the exact command). Nothing is installed or launched for you."
      : null,
    mercuryBlenderEnabled()
      ? '- Blender lanes are ARMED: .blend files get headless render/python launch profiles (operator-run — the tool prints the exact command, arguments in documented order) and the debugpy attach recipe (a one-line listener inside Blender, then Debug attach adapter python); the `Blender` tool drives your running Blender over the loopback bridge (scene/objects truth, blend opens, still renders, report tail, python_run — ask-gated) once the add-on is installed (op:"blender_bridge_install") and enabled in Preferences (your act). Nothing is installed or launched for you.'
      : null,
    mercuryAsepriteEnabled()
      ? '- Aseprite lanes are ARMED: the `Aseprite` tool drives the local Aseprite in BATCH mode per operation (sprite census via op:"info", PNG/GIF/sprite-sheet exports, new sprites, Lua run-script — exports and creates ask naming their files, run-script always asks; a GUI is never launched). The tool joins the catalog beside sprite files or wherever the app is located; no Aseprite on the box ⇒ ops teach the install roads. Nothing is installed or launched for you.'
      : null,
    mnemeEnabled()
      ? '- Topic memory (MNEME) is ARMED: the mneme_* tools maintain long-term topic documents beside auto-memory — prefer them for durable facts/decisions. Record with mneme_observe (findable IMMEDIATELY via mneme_grep, even before consolidation); when a fact CHANGES, use mneme_correct (supersede by seq — never record a contradicting duplicate); mneme_retire marks a fact no longer current.'
      : null,
    themisActive()
      ? `- THEMIS control plane is ACTIVE (${themisLevel()}): deterministic policy checks run against tool calls; a THEMIS denial is policy, not tool failure.`
      : null,
    crewEnabled() ? '- Crews: /teammates manages named crew workers.' : null,
  ]
  return lines.filter((l): l is string => l !== null)
}

export function getHarnessMapSection(): string | null {
  if (memo !== undefined) return memo
  if (!harnessMapEnabled()) {
    memo = null
    return memo
  }
  memo = [
    '# Mercury harness map',
    'You are running natively inside Mercury — a sovereign, source-built terminal harness with first-class surfaces beyond the standard tool set. Route by this map instead of guessing from generic-CLI priors:',
    ...computeHarnessMapLines(),
    '- A surface missing from this map is gated off in this boot — /capabilities has the live verdicts.',
  ].join('\n')
  // The delta baseline starts at what the PROMPT announced (this boot map).
  if (announcedLines === null) announcedLines = computeHarnessMapLines()
  return memo
}

// ── the mid-session DELTA (#182) ─────────────────────────────────────────────
// The prompt block is memoized for cache stability, so a mid-session gate flip
// (/invite arm · a THEMIS mode change) never reaches the model.
// This diff runs per turn (a dozen boolean gate reads — cheap), against the
// ANNOUNCED set. That set is RECONSTRUCTED from the thread's own message
// history (the mcp_instructions_delta pattern): the boot baseline — what the
// prompt block said — plus every harness_map_delta attachment that actually
// LANDED in the conversation. Returning a delta never advances any state, so
// (a) an aborted turn's collected-but-never-appended attachment re-announces
// next turn instead of being lost forever, and (b) a second consumer thread
// can't swallow the main session's one announcement (the orchestrator
// additionally gates the producer to the main thread). `announcedLines` is
// the write-once PROMPT baseline, never a consumption cursor.
let announcedLines: string[] | null = null

/** The minimal message shape the reconstruction reads (structural — the full
 *  Message union lives in types/message.ts; only attachment rows matter). */
type AttachmentishMessage = {
  type: string
  attachment?: { type: string; added?: string[]; removed?: string[] }
}

export function getHarnessMapDelta(
  messages?: readonly AttachmentishMessage[],
): { added: string[]; removed: string[] } | null {
  if (!harnessMapEnabled()) return null
  const live = computeHarnessMapLines()
  if (announcedLines === null) {
    // No prompt block was built in this process (the section is what seeds
    // the baseline) — baseline silently on first sight; announcing a "delta"
    // against nothing would replay the whole map.
    announcedLines = live
    return null
  }
  const announced = new Set(announcedLines)
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    const att = msg.attachment
    if (!att || att.type !== 'harness_map_delta') continue
    for (const l of att.added ?? []) announced.add(l)
    for (const l of att.removed ?? []) announced.delete(l)
  }
  const now = new Set(live)
  const added = live.filter(l => !announced.has(l))
  const removed = [...announced].filter(l => !now.has(l))
  if (added.length === 0 && removed.length === 0) return null
  return { added, removed }
}

/** Test-only: clear the memo + the delta baseline (proofs flip env). */
export function resetHarnessMapForTest(): void {
  memo = undefined
  announcedLines = null
}
