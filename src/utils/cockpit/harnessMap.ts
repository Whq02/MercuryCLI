
import { dapAdapterProbePending, mercuryDapEnabled, reachableDapAdapterKeys } from '../../services/dap/dapClient.js'
import { mercuryGodotEnabled } from '../../services/lsp/godotLane.js'
import { mercuryUnityEnabled } from '../../services/ide/unityProject.js'
import { mercuryBlenderEnabled } from '../../services/ide/blenderProject.js'
import { mercuryAsepriteEnabled } from '../../services/aseprite/asepriteApp.js'
import { isSaturnSchedulingEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { dynamicWorkflowsEnabled } from '../../tools/WorkflowTool/workflowEnablement.js'
import { getVulcanHarnessMapLine } from '../vulcan/vulcanGates.js'
import { isSessionMarkedNonInteractive } from './runtimePosture.js'
import { healthCertEnabled } from '../healthReport.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function harnessMapEnabled(): boolean {
  if (flagEnv('MERCURY_HARNESS_MAP') === '0') return false
  if (isSessionMarkedNonInteractive()) return false
  return true
}

let memo: string | null | undefined

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
function dapReachableSafe(): boolean {
  try {
    return reachableDapAdapterKeys().length > 0
  } catch {
    return false
  }
}

export function computeHarnessMapLines(): string[] {
  const lines: Array<string | null> = [
    `- Discovery: /help lists commands; /capabilities is the live capability matrix for this build${healthCertEnabled() ? '; /health runs the evidence-backed health certificate' : ''}; a surface missing from this map is gated off in this boot.`,
    dynamicWorkflowsEnabled()
      ? '- Deterministic multi-agent orchestration: the Workflow tool; /workflows is its board → run → inspector.'
      : null,
    isSaturnSchedulingEnabled()
      ? '- Scheduled/recurring runs (SATURN): the CronCreate · CronList · CronDelete tools; /saturn is the board; its `a` key creates a scheduled run.'
      : null,
    mercuryDapEnabled() && !dapReachableSafe() && !dapAdapterProbePending()
      ? '- The Debug tool is withheld on this machine: no debug adapter is reachable, so no launch could work. Arm one — Python `pip install debugpy` (or a build carrying the vendored adapter) · native `xcode-select --install` (lldb-dap) or gdb 14+ · JS: unpack js-debug to ~/.js-debug · Go `go install github.com/go-delve/delve/cmd/dlv@latest` — then start a new session or /clear for the tool to join.'
      : null,
    projectIntelEnabledSafe() && refsEnabledSafe()
      ? '- Project intelligence: mercury://project/current resolves the generation-keyed snapshot (modules · changes · knowledge · checks), ?child=context&q=<task> assembles the explained task working set, ?child=impact&q=<path> projects established impact, ?child=split&q=<a> || <b> proposes a two-operator division; a context_capsule reminder in your context is the current working set (evidence-ranked refs — dereference to read); mercury://transcript/session|agent gives bounded concise transcript views; /orient pin|drop corrects the working set.'
      : null,
    mercuryGodotEnabled()
      ? "- Godot lanes are armed: in a Godot project (project.godot at the root), the editor GDScript LSP and the Debug tool's `godot` DAP adapter are live over the loopback bridge — use them for GDScript symbol and runtime work."
      : null,
    getVulcanHarnessMapLine(),
    mercuryUnityEnabled()
      ? "- Unity lanes are armed: in a Unity project (Assets/ + ProjectSettings/ at the root), .cs gets the C# LSP lane (PATH server) and the Debug tool's `unity` adapter attaches to the running editor; the `Unity` tool drives that editor over the loopback bridge (play mode, scenes, hierarchy, console, Test Runner) once the bridge package is installed (op:\"unity_bridge_install\"); headless test/build launch profiles are operator-run (the tool prints the exact command). Nothing is installed or launched for you."
      : null,
    mercuryBlenderEnabled()
      ? '- Blender lanes are armed: .blend files get headless render/python launch profiles (operator-run — the tool prints the exact command, arguments in documented order) and the debugpy attach recipe (a one-line listener inside Blender, then Debug attach adapter python); the `Blender` tool drives your running Blender over the loopback bridge (scene/objects truth, blend opens, still renders, report tail, python_run — ask-gated) once the add-on is installed (op:"blender_bridge_install") and enabled in Preferences (your act). Nothing is installed or launched for you.'
      : null,
    mercuryAsepriteEnabled()
      ? '- Aseprite lanes are armed: the `Aseprite` tool drives the local Aseprite in batch mode per operation (sprite census via op:"info", PNG/GIF/sprite-sheet exports, new sprites, Lua run-script — exports and creates ask naming their files, run-script always asks; a GUI is never launched). The tool joins the catalog beside sprite files or wherever the app is located; no Aseprite on the box ⇒ ops teach the install roads. Nothing is installed or launched for you.'
      : null,
  ]
  return lines.filter((l): l is string => l !== null)
}

export function getHarnessMapSection(): string | null {
  if (memo !== undefined) return memo
  if (!harnessMapEnabled()) {
    memo = null
    return memo
  }
  memo = ['# Mercury harness map', ...computeHarnessMapLines()].join('\n')
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
