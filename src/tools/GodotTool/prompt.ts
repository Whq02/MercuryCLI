import { VULCAN_OPS, type VulcanOp } from '../../utils/vulcan/optable.generated.js'
import { vulcanLiteMode } from '../../utils/vulcan/vulcanGates.js'

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
  return `Drive the running Godot editor directly (the VULCAN surface): scenes, nodes, scripts, resources, animation, physics, audio, tilemaps, shaders — plus play-testing with runtime inspection and input simulation. Editor state is the source of truth: open with project_capsule (the one-call project picture — autoloads, input actions, global classes, scenes, presets; answers from project files even before the editor is up), then query (scene_tree, node_get, editor_state) before you mutate. Editor mutations use an editor undo step; engine jobs and frame images are separate files, not editor edits.

Call shape: { op: "<name>", args: { … } }. Values are smart-parsed editor-side: "Vector2(100, 200)", "Color(1,0,0)", hex color strings (# followed by rrggbb), "Vector3(…)", "Rect2(…)", NodePaths, and res:// paths may be passed as strings. Editor file arguments must be res://-relative (absolute paths are refused); engine frame inputs can be local absolute or project-relative PNG paths. Bridge errors return {code, message, hint}; engine records name their own failure and log paths.

Ops marked [exec] run code or drive input (play, simulate, execute, export) and always ask permission. ${lite ? 'LITE MODE is on: the core 76-op subset is available; other ops answer with a teaching note (unset MERCURY_GODOT_TOOLS_LITE for the full surface).' : 'The full op surface is available.'}

Setup: the mercury_vulcan addon must be installed in the project and the editor open with it loaded. Each instance has its own port and token. op:"vulcan_status" names the addon, discovered instances and executable; op:"engine_jobs" lists workers. Pass args.instance to name the instance you want. Editor operations never choose the operator-editor role unless the call explicitly names it; an ambiguous selection is refused rather than guessed. Every bridge answer names the instance reached. op:"vulcan_install" materializes + enables the addon and receipts every project.godot row it writes. An already-open editor does not load a newly enabled addon by itself; no operator editor is reloaded implicitly. New class_name scripts stay invisible to headless runs until the class cache is rebuilt — op:"project_refresh_classes" (the capsule and script_validate say when it is stale).

Engine job service (Mercury's own headless Godot workers; the editor is never involved): op:"engine_run" runs the suites registered in .mercury/engine-suites.json on a frozen copy of the project — a git ref, or HEAD plus your own files, never another agent's half-edit — in parallel workers, each with its own .godot and an empty user directory, and answers the runner-shaped record (per suite: the marker line, exit code, clean log, seconds, the FAIL and SCRIPT ERROR lines, the file each error names and who last changed it). op:"engine_check" is the compile gate: the changed .gd files parsed and type-checked one by one and the changed .gdshader files compiled, in seconds, with the project's autoload identifiers ignored exactly. op:"engine_jobs", op:"engine_cancel" and op:"engine_result" manage the queue (priorities verifier > fold-gate > lane-gate > profile). Run engine_check after an edit batch and engine_run before calling work done; a native (display) run is one at a time and never beside the operator's own editor unless asked.

Capture and measurement jobs: op:"engine_capture" runs a named or inline tour on its own frozen instance, with a fixed capture clock, isolated frame paths and a contact sheet in the result. A capture pair repeats one tour with one switch flipped. op:"engine_frames" {action:"diff", a, b} returns a changed-pixel fraction, component boxes and a small mask; {action:"stats", frame} returns row/column repeat correlations, streak anisotropy, high-frequency energy and grid colours; {action:"contact-sheet", id} returns a small sheet of that run. op:"engine_profile" settles an isolated instance before measuring, checks for competing engine workers, keeps in-boot A/B halves together, and can store or compare a commit baseline. These jobs never attach to the operator's editor or game. No real display is used unless explicitly requested; unsupported off-screen rendering is a refusal, not a visible fallback. The CLI equivalents are mercury godot capture|frames|profile; mercury godot tour <name> returns the tour's contact sheet path.

Runtime state from your own worker: engine_scene_tree {instance}, engine_node_get {instance,node,properties}, engine_node_call {instance,node,method,args}, and engine_signal_wait {instance,node,signal,timeout_ms}. Read the instance id from engine_jobs; queries use that instance's own bridge, not the operator's editor. A job id from engine_jobs works too: an engine_run job's id reaches its worker's bridge, and a running engine_profile job's id (source engine or auto) reads its live scene tree over the engine debugger during the measurement boot. Before a worker is up the answer says what it is waiting for; a capture boot has no query road. Only engine_node_call runs code and asks permission. File ownership without a team: lease_take {paths}, lease_list {}, lease_release {}. Your session and agent hold the paths until release or session end; a run refuses changed files held by someone else. engine_check also reports proof drift against the selected tree's own commit (HEAD for working and HEAD+files; a git ref is compared with itself): removed or weakened assertions and a fallen check count make the gate fail, as does a SCRIPT ERROR hidden under a suite's PASS.

Routing: GDScript SYMBOL work (outline, definitions, references, rename) → the LSP tool. BREAKPOINT debugging (breakpoints, stepping, stack) → the Debug tool's godot adapter. Play-test flows (scene_play → runtime_* → scene_stop), scene/node/resource editing, and profiling live HERE.

Driving a game turn by turn: op:"runtime_pause" (or the first op:"runtime_step") parks the game while you think, op:"runtime_step" {frames | ms} advances it exactly that far and answers with the frames run and the errors/log since — every press you sent meanwhile is delivered at the window's start, and a press is a real InputEventAction the game's _input/_unhandled_input callbacks and Input.is_action_pressed both see — and op:"runtime_resume" lets it run live again. One call per act: op:"input_sequence" steps carry step_frames (advance after the step), so a walk-and-attack is one call: steps [{action:"left", pressed:true, step_frames:30}, {action:"left", pressed:false}, {action:"attack", step_frames:10}].

Op catalog (name(args) — ? marks optional):
${getGodotOpCatalog()}`
}
