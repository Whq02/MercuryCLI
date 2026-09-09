
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

export function harnessMapEnabled(): boolean {
  if (flagEnv('MERCURY_HARNESS_MAP') === '0') return false
  if (isSessionMarkedNonInteractive()) return false
  return true
}

let memo: string | null | undefined

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
function lspConnectedSafe(): boolean {
  try {
    return (require('../../services/lsp/manager.js') as typeof import('../../services/lsp/manager.js')).isLspToolMounted()
  } catch {
    return false
  }
}
function dapReachableSafe(): boolean {
  try {
    return reachableDapAdapterKeys().length > 0
  } catch {
    return false
  }
}

export function computeHarnessMapLines(): string[] {
  const lines: Array<string | null> = [
    `- Discovery: /help lists commands; /capabilities is the live capability matrix for THIS build${healthCertEnabled() ? '; /health runs the evidence-backed health certificate' : ''}.`,
    '- Provider-API reference: invoke the bundled provider-apis skill for request shapes, streaming, tool calls and caching. Model currency is covered by the model-currency instruction.',
    isAutoMemoryEnabled() || experienceCardsEnabled()
      ? '- Experience cards: /cards reviews the durable lessons in memory.'
      : null,
    isTabulaEnabled()
      ? '- Project notepad (TABULA): /note <text> captures a note for this project; /tabula opens the board. Notes survive /clear — prefer them for cross-session reminders.'
      : null,
    dynamicWorkflowsEnabled()
      ? '- Deterministic multi-agent orchestration: the Workflow tool; /workflows is its board → run → inspector.'
      : null,
    isSaturnSchedulingEnabled()
      ? '- Scheduled/recurring runs (SATURN): the CronCreate · CronList · CronDelete tools; /saturn is the board; its `a` key creates a scheduled run.'
      : null,
    (isLspToolCatalogEnabled() && lspConnectedSafe()) || (isDapToolCatalogEnabled() && dapReachableSafe())
      ? `- Code intelligence is native: ${[isLspToolCatalogEnabled() && lspConnectedSafe() ? 'the LSP tool (diagnostics, rename, code actions, pathRename file moves, fixDiagnostic)' : null, isDapToolCatalogEnabled() && dapReachableSafe() ? 'the Debug tool (a real DAP debugger: breakpoints, stepping, evaluate)' : null].filter(Boolean).join(' and ')} — prefer them over grep-and-rerun for symbol and runtime-state work.`
      : null,
    isDapToolCatalogEnabled() && !dapReachableSafe()
      ? '- The Debug tool is cataloged but NO debug adapter is reachable on this machine — a launch will refuse with the per-adapter remedy. Arm one: Python `pip install debugpy` (or a build carrying the vendored adapter) · native `xcode-select --install` (lldb-dap) or gdb 14+ · JS: unpack js-debug to ~/.js-debug · Go `go install github.com/go-delve/delve/cmd/dlv@latest`.'
      : null,
    workshopEnabledSafe()
      ? '- Persistent analysis cells: the Workshop tool runs js/ts/py cells with RETAINED state across calls (mercury.tool/agent/inspect compose normal tools inside cells) — prefer it for multi-step data work over re-running Bash pipelines.'
      : null,
    servicesEnabledSafe()
      ? '- Long-lived project processes: the Service tool (start/wait/logs/stop with readiness conditions + cursored logs) — use it instead of backgrounded Bash for servers, watch builds, and local APIs; services are addressable as mercury://service/<name>.'
      : null,
    refsEnabledSafe()
      ? "- The work graph is addressable: mercury://<kind>/<id> refs (runs, receipts, tasks, teams, workflows, services, lanes, artifacts, health) resolve through the Inspect tool — follow refs instead of replaying transcripts."
      : null,
    projectIntelEnabledSafe() && refsEnabledSafe()
      ? '- Project intelligence is native: mercury://project/current resolves the generation-keyed snapshot (modules · changes · knowledge · checks), ?child=context&q=<task> assembles the EXPLAINED task working set, ?child=impact&q=<path> projects established impact, ?child=split&q=<a> || <b> proposes a two-operator division; a context_capsule reminder in your context IS the current working set (evidence-ranked refs — dereference to read); mercury://transcript/session|agent gives bounded concise transcript views; /orient pin|drop corrects the working set.'
      : null,
    lanesEnabledSafe()
      ? '- Bounded side questions: /branch <goal> forks a side lane with an explicit boundary; /branch return <answer> records a typed handoff and flips back; /branches lists. Prefer a lane over derailing the main thread for a genuine tangent.'
      : null,
    counselArmedSafe()
      ? '- Counsel is ARMED: a bounded second look reviews observed change receipts (/counsel run — manual; auto delivery lands cards at turn boundaries). Treat its findings as evidence review, not authority.'
      : null,
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
  if (announcedLines === null) announcedLines = computeHarnessMapLines()
  return memo
}

let announcedLines: string[] | null = null

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

export function resetHarnessMapForTest(): void {
  memo = undefined
  announcedLines = null
}
