import { VULCAN_OPS, type VulcanOp } from '../../utils/vulcan/optable.generated.js'
import { vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'

export const GODOT_TOOL_NAME = 'Godot' as const

function opSignature(op: VulcanOp): string {
  const args = Object.entries(op.args).map(([k, note]) =>
    /^optional/i.test(note) ? `${k}?` : k,
  )
  return `${op.name}(${args.join(', ')})${op.cls === 'exec' ? ' [exec]' : ''}`
}

export function getGodotOpCatalog(): string {
  const lite = vulcanLiteMode()
  const ops = VULCAN_OPS.filter(o => (lite ? o.lite || o.category === 'frontier' : true))
  const byCat = new Map<string, VulcanOp[]>()
  for (const op of ops) {
    const list = byCat.get(op.category) ?? []
    list.push(op)
    byCat.set(op.category, list)
  }
  const lines: string[] = []
  for (const [cat, list] of byCat) {
    lines.push(`${cat}: ${list.map(opSignature).join(' · ')}`)
  }
  return lines.join('\n')
}

export function getGodotToolDescription(): string {
  const lite = vulcanLiteMode()
  return `Drive the running Godot editor directly (the VULCAN surface): scenes, nodes, scripts, resources, animation, physics, audio, tilemaps, shaders — plus play-testing with runtime inspection and input simulation. Editor state is the source of truth: open with project_capsule (the one-call project picture — autoloads, input actions, global classes, scenes, presets; answers from project files even before the editor is up), then query (scene_tree, node_get, editor_state) before you mutate. Every mutation is ONE editor undo step (Ctrl+Z reverts it).

Call shape: { op: "<name>", args: { … } }. Values are smart-parsed editor-side: "Vector2(100, 200)", "Color(1,0,0)", hex color strings (# followed by rrggbb), "Vector3(…)", "Rect2(…)", NodePaths, and res:// paths may be passed as strings. File arguments must be res://-relative (absolute paths are refused). Errors return {code, message, hint} — the hint says what to try instead.

Ops marked [exec] run code or drive input (play, simulate, execute, export) and always ask permission. ${lite ? 'LITE MODE is on: the core 76-op subset is available; other ops answer with a teaching note (unset MERCURY_GODOT_TOOLS_LITE for the full surface).' : 'The full op surface is available.'}

Setup: the mercury_vulcan addon must be installed in the project and the editor open with it loaded. op:"vulcan_status" probes everything (flag, addon, the editor state — no editor running / editor open but unbridged / bridge up on 127.0.0.1:${vulcanPort()} — plus where the Godot executable lives); op:"vulcan_install" materializes + enables the addon and receipts every project.godot row it writes. An already-open editor does not load a newly enabled editor plugin by itself: the status names the exact action (a headless editor needs a restart; with a bridge already up, vulcan_install reloads the editor plugin for you). An absent editor answers with a teaching error, never a hang. New class_name scripts stay invisible to headless runs until the class cache is rebuilt — op:"project_refresh_classes" (the capsule and script_validate say when it is stale).

Routing: GDScript SYMBOL work (outline, definitions, references, rename) → the LSP tool. BREAKPOINT debugging (breakpoints, stepping, stack) → the Debug tool's godot adapter. Play-test flows (scene_play → runtime_* → scene_stop), scene/node/resource editing, and profiling live HERE.

Driving a game turn by turn: op:"runtime_pause" (or the first op:"runtime_step") parks the game while you think, op:"runtime_step" {frames | ms} advances it exactly that far and answers with the frames run and the errors/log since — every press you sent meanwhile is delivered at the window's start, and a press is a real InputEventAction the game's _input/_unhandled_input callbacks and Input.is_action_pressed both see — and op:"runtime_resume" lets it run live again. One call per act: op:"input_sequence" steps carry step_frames (advance after the step), so a walk-and-attack is one call: steps [{action:"left", pressed:true, step_frames:30}, {action:"left", pressed:false}, {action:"attack", step_frames:10}].

Op catalog (name(args) — ? marks optional):
${getGodotOpCatalog()}`
}
