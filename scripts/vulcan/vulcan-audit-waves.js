// Run one wave at a time so fixes land between waves (the plan's contract):
//   Workflow({scriptPath: 'scripts/vulcan/vulcan-audit-waves.js', args: {wave: 'A1'}})
// Omitting args runs all five back-to-back (no fix windows — not the default).
export const meta = {
  name: 'vulcan-audit-waves',
  description: 'Five sequential fable-5 audit waves over VULCAN + surrounding substrate',
  phases: [
    { title: 'A1 addon correctness' },
    { title: 'A2 security red-team' },
    { title: 'A3 wiring + regressions' },
    { title: 'A4 UI/UX + docs honesty' },
    { title: 'A5 skeptic sweep' },
  ],
}

const ONLY = args && args.wave ? String(args.wave).toUpperCase() : null
const want = k => ONLY === null || ONLY === k

const SCHEMA = {
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'severity', 'summary', 'failure_scenario'],
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { enum: ['critical', 'major', 'minor', 'nit'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
}

const COMMON = `
You are auditing VULCAN — the native Godot editor-control surface just built in this repo (Mercury).
READ-ONLY: do NOT edit any file; REPORT findings only (the integrator fixes by hand).
Ground yourself first: assets/vulcan/optable.json.
The new surfaces: src/utils/vulcan/*, src/services/vulcan/*, src/tools/GodotTool/*, assets/vulcan/addon/**, scripts/vulcan/*, plus edits in src/tools.ts, src/constants/prompts.ts, src/constants/subagentDoctrine.ts, src/utils/cockpit/harnessMap.ts, src/substrate/startupMenu.ts, src/substrate/flagRegistry.ts, src/utils/doctorReport.ts, assets/splash/mercury-splash.mjs.
Report ONLY defects you can argue concretely (file, line, failure scenario). No style nits unless they mask a bug. Severity honestly.
`

phase('A1 addon correctness')
const a1 = !want('A1') ? null : await agent(COMMON + `
YOUR LENS — addon correctness & protocol (GDScript): misused Godot 4 APIs (EditorInterface, EditorUndoRedoManager, TileMapLayer, AudioServer, Input synthesis, Expression), NDJSON framing bugs (partial lines, oversized frames, id reuse), the hello/token state machine, runtime-bridge lifecycle (autoload add/remove, back-connect, play/stop races), UndoRedo coverage on every mutate op, smart-type-parsing edge cases (negative numbers, nested constructors, malformed hex), error frames missing hints. Also cross-check categories/*.gd ops() lists against assets/vulcan/optable.json.`,
  { label: 'A1', model: 'fable', phase: 'A1 addon correctness', schema: SCHEMA })

phase('A2 security red-team')
const a2 = !want('A2') ? null : await agent(COMMON + `
YOUR LENS — security red-team. Threat model: a malicious process on the same machine, a malicious Godot project (hostile project.godot / addon tampering), a compromised game runtime, a hostile peer feeding frames. Attack the token (timing, file perms, symlink at .godot/mercury-vulcan-token, override env), the loopback assumptions, res:// guard escapes (.. traversal, res://../..,  user://, absolute windows paths, NodePath tricks), editor_execute_script and runtime_eval reachability without consent (permission classes in src/tools/GodotTool/GodotTool.ts + the optable exec set), the installer's project.godot rewrite (regex injection via plugin names), oversized/malformed frame handling both sides, event-frame spoofing, the addon writing outside the project. Verify every mutating path is behind ask-or-rule permission.`,
  { label: 'A2', model: 'fable', phase: 'A2 security red-team', schema: SCHEMA })

phase('A3 wiring + regressions')
const a3 = !want('A3') ? null : await agent(COMMON + `
YOUR LENS — Mercury-side wiring + substrate regressions. Byte-identical-OFF: any prompt bytes, file writes, or catalog changes when MERCURY_GODOT_TOOLS is unset? (check getVulcanSection/getVulcanDoctrineLine/getVulcanHarnessMapLine callers, tools.ts spread, token creation paths). The harness-map memo + delta interplay (does the armed line break announce-once? does resetHarnessMapForTest cover it?). getAllBaseTools per-call cost of findGodotProjectRoot (fs walk on EVERY catalog assembly — is it cached/cheap enough? propose if not). vulcanClient singleton lifecycle across cwd changes. The prompts.ts modeSections splice (double-call of getVulcanSection). subagentDoctrine growth. flagRegistry polarity (opt-in reads). startupMenu row move side effects (write-through, bake, prove-startup-menu). Any regression risk to LSP/DAP godot lanes (shared godotLane imports).`,
  { label: 'A3', model: 'fable', phase: 'A3 wiring + regressions', schema: SCHEMA })

phase('A4 UI/UX + docs honesty')
const a4 = !want('A4') ? null : await agent(COMMON + `
YOUR LENS — UI/UX + docs/registry honesty. The boot-menu miscellaneous group (row copy, detail panes, the new wide-menu windowed viewport in assets/splash/mercury-splash.mjs — off-by-one in the window math, marker rows, selection visibility at small heights, the LAYOUT-TIER INVARIANT). /doctor vulcan check copy + status honesty. The Godot tool's prompt/description (op catalog generation, lite advertisement truthfulness). Docs vs code drift: the guide rows and the in-code flag registry — every claim must match source. No emoji in TUI sources, zero new hex outside the theme.`,
  { label: 'A4', model: 'fable', phase: 'A4 UI/UX + docs honesty', schema: SCHEMA })

phase('A5 skeptic sweep')
const a5 = !want('A5') ? null : await agent(COMMON + `
YOUR LENS — full-system skeptic. Assume the other four auditors missed something. Hunt cross-cutting failures: proof gaps (what do scripts/vulcan proofs NOT pin that could regress silently?), the optable-to-schema-to-addon triple agreement, concurrency (isConcurrencySafe false — but two Mercury sessions on one project? the shared token file? two clients one addon?), the events ring dropping under flood, install/uninstall idempotence + partial-failure states, lite-mode bypass via frontier ops, headless (-p) behavior of all new prompt seams, build.ts bundling of the generated modules, and anything in the previous waves' blind spots. Also sanity-check the surrounding files these changes touched for collateral damage.`,
  { label: 'A5', model: 'fable', phase: 'A5 skeptic sweep', schema: SCHEMA })

return { a1, a2, a3, a4, a5 }
