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
  return `Drives the running Godot editor over the VULCAN bridge — scenes, nodes, scripts, resources, animation, physics, audio, tilemaps, shaders, play-testing with runtime inspection and input simulation — and runs Mercury's own headless engine jobs. Call shape: { op: "<name>", args: { … } }; a bridge error returns {code, message, hint}, and every bridge answer names the instance reached. An editor mutation is one undo step; engine jobs and frame images are files, not editor edits. Argument values are parsed editor-side, so "Vector2(100, 200)", "Color(1,0,0)", "#rrggbb", "Vector3(…)", "Rect2(…)", NodePaths and res:// paths may be passed as strings; editor file arguments are res://-relative, and engine frame inputs are local absolute or project-relative PNG paths. project_capsule answers from the project files even before the editor is up.

Ops marked [exec] run code or drive input and ask permission.${lite ? ' LITE MODE is on: the catalog below is the core subset.' : ''}

Each editor instance has its own port and token; vulcan_status names the addon, the discovered instances and the executable. Pass args.instance to name the instance you want: editor operations never choose the operator-editor role unless the call explicitly names it. vulcan_install writes and enables the addon, receipting every project.godot row it writes; an open editor does not load a newly enabled addon by itself. A new class_name script stays invisible to headless runs until project_refresh_classes rebuilds the class cache.

Engine jobs run on a frozen copy of the project — a git ref, or HEAD plus your own files — in workers of their own, never in the operator's editor. engine_run runs the suites registered in .mercury/engine-suites.json in parallel workers, each with its own .godot and an empty user directory, and answers per suite the marker line, exit code, clean log, seconds, the FAIL and SCRIPT ERROR lines, and the file each error names with who last changed it. engine_check parses and type-checks the changed .gd files and compiles the changed .gdshader files, with the project's autoload identifiers ignored exactly, and reports proof drift against the tree's own commit: removed or weakened assertions, a fallen check count or a SCRIPT ERROR under a suite's PASS fail the gate. engine_jobs, engine_cancel and engine_result manage the queue (priorities verifier > fold-gate > lane-gate > profile); a native display run is one at a time. engine_capture runs a named or inline tour on its own instance with a fixed capture clock and isolated frame paths and returns a contact sheet; engine_frames {action:"diff", a, b} returns a changed-pixel fraction, component boxes and a small mask, {action:"stats", frame} repeat correlations, streak anisotropy, high-frequency energy and grid colours, and {action:"contact-sheet", id} a sheet of that run; engine_profile settles an isolated instance before measuring, keeps in-boot A/B halves together, and can store or compare a commit baseline. No real display is used unless the call asks for one. engine_scene_tree, engine_node_get, engine_node_call and engine_signal_wait read a worker's live game over its own bridge, named by the instance id from engine_jobs or by an engine_run or running engine_profile job id; of these only engine_node_call runs code and asks permission. lease_take, lease_list and lease_release hold project paths for this session and agent until release or session end.

runtime_pause, or the first runtime_step, parks the game; runtime_step {frames | ms} advances it exactly that far and answers with the frames run and the errors and log since, delivering every press sent meanwhile at the window's start as a real InputEventAction; runtime_resume lets it run live. An input_sequence step carries step_frames to advance after it.

Ops (name(args), ? optional):
${getGodotOpCatalog()}`
}
