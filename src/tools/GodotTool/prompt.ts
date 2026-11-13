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
  return `Drives the running Godot editor over the VULCAN bridge and runs Mercury's headless engine jobs. Call shape: { op: "<name>", args: { … } }; bridge errors return {code, message, hint}, and bridge answers name the instance reached. Editor mutations are one undo step except import_set and refactor_rename_* (which write project files with a receipt); engine jobs and frame PNGs write files directly. Values parse editor-side ("Vector2(100, 200)", "Color(1,0,0)", "#rrggbb", "Vector3(…)", "Rect2(…)", NodePaths, res:// paths); editor file args are res://-relative, while engine frame inputs are local absolute or project-relative PNGs. project_capsule reads project files even without an open editor.

Mutating ops ask permission ([exec] marks code and input).${lite ? ' LITE MODE is on: core subset below.' : ''}

Instances have distinct ports and tokens; vulcan_status reports the addon, discovered instances and executable. Pass args.instance to target one: editor operations never choose the operator-editor role unless the call explicitly names it. vulcan_install writes and enables the addon (receipting project.godot rows; open editors do not hot-load newly enabled addons). New class_name scripts need project_refresh_classes before headless runs see them.

Engine jobs run in isolated workers on a frozen copy (a git ref, or HEAD + your files), never in the operator's editor, and use no real display unless requested. engine_run runs .mercury/engine-suites.json suites in parallel (isolated .godot and empty user://), returning marker line, exit code, clean log, duration, FAIL/SCRIPT ERROR lines and last-author attribution per error file. engine_check parses/type-checks changed .gd files (ignoring autoloads) and compiles changed .gdshader files, failing on proof drift (removed/weakened assertions, lower check count, or SCRIPT ERROR under PASS). engine_jobs, engine_cancel and engine_result manage the queue (verifier > fold-gate > lane-gate > profile; native-display runs serialize). engine_capture runs a tour on a fixed clock and returns a contact sheet; engine_frames handles "diff" (changed fraction, boxes, mask), "stats" (repeat correlations, streak anisotropy, HF energy, grid colours) and "contact-sheet"; engine_profile settles before measuring, pairs in-boot A/B halves and compares commit baselines. engine_scene_tree, engine_node_get, engine_node_call ([exec], asks) and engine_signal_wait inspect a worker's live game by instance or job id. lease_take, lease_list and lease_release hold project paths until release or session end.

runtime_pause (or first runtime_step) parks the game; runtime_step {frames | ms} advances by that exact span, delivering queued presses at window start as InputEventActions and returning frames, errors and logs; runtime_resume resumes live play. input_sequence steps accept step_frames.

Ops (name(args), ? optional):
${getGodotOpCatalog()}`
}
