


import { getMercuryHome } from '../utils/envUtils.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { flagEnabled, flagEnv, flagSpellings, stampFlagOnEnv } from './flagRegistry.js'
import { addBootNote } from './bootNotes.js'
import { themisActive } from './themis/level.js'

export interface MenuRow {
  env: string
  label: string
  group: string
  kind: 'toggle' | 'enum' | 'string'
  options: readonly string[]
  defaultLabel: string
  summary: string
  detail?: {
    controls: string
    on: readonly string[]
    off: readonly string[]
  }
}

export interface MenuChoice {
  value: string | null
  label: string
}

export const STARTUP_MENU: readonly MenuRow[] = [
  {
    env: 'MERCURY_WARDS',
    label: 'Content-rule wards',
    group: 'trust combo',
    kind: 'toggle',
    options: ['0'],
    defaultLabel: 'on',
    summary: 'denies edits/commands that break the mechanical house rules (stray hex colors · emoji in TUI code · force-push to main) and teaches the fix',
    detail: {
      controls: 'Deterministic rules over pending tool calls: a violating edit or command is denied with a short teaching note (which rule, what to do instead). Project rules extend via .mercury/wards.json; rules cost nothing until violated. Pairs with the self-check gate + Debug tool — the trust combo.',
      on: ['new hex outside the theme tokens, emoji in TUI sources, and force-pushes to main are denied at the moment of the call', 'denials name the rule and the compliant alternative'],
      off: ['no content rules — the gate-time ratchets remain the only backstop'],
    },
  },
  {
    env: 'MERCURY_DAP',
    label: 'Debug tool (real debugger)',
    group: 'trust combo',
    kind: 'toggle',
    options: ['0'],
    defaultLabel: 'on',
    summary: 'a real debugger the agent can drive — breakpoints, stepping, variables, evaluate — instead of print statements',
    detail: {
      controls: 'The Debug tool speaks the Debug Adapter Protocol to real debuggers (Python via debugpy, native code via lldb-dap). Launching a program under the debugger always asks permission first. Rounds out the trust combo: real runtime evidence instead of guesses.',
      on: ['the Debug tool joins the catalog', 'launch asks permission like any command execution', 'inspection (stacks, variables) rides the permitted session'],
      off: ['the tool is absent — identical to a build without it'],
    },
  },
  {
    env: 'MERCURY_THEMIS',
    label: 'Run discipline (THEMIS)',
    group: 'trust combo',
    kind: 'enum',
    options: ['warn', 'enforce', 'off'],
    defaultLabel: 'enforce',
    summary: 'built-in attack-shape checks on risky commands, ON by default — enforce refuses with a typed message (never a prompt), warn records only, off disarms; tracked change missions (/mission) ride the same level',
    detail: {
      controls: "Two things, truthfully: (1) a FIXED set of built-in attack-shape checks on risky shell/config commands (supply-chain installs, persistence, git-config mutation — house-style rules live in Wards) with a tamper-evident audit log; (2) tracked change MISSIONS for substantial work (/mission) — bounded criteria, expected paths, fresh verification evidence to complete. ON at enforce by default, measured imperceptible (sub-µs per call, ~0.1% of a real command round). A refused command is a typed teaching message — never a permission prompt; warn records without blocking when legitimate work trips a rule. No model calls, no spend.",
      on: ["risky command shapes are checked before running (enforce refuses · warn records) — a typed refusal, never a prompt", "a tamper-evident audit log accrues under the project's themis store", "/mission tracks substantial changes; enforce refuses unexpected-path edits ONLY while a mission is active"],
      off: ["explicit off: no checks, no audit log, no /mission", "repo generation (DAEDALUS) becomes unavailable — it requires this layer"],
    },
  },
  {
    env: 'MERCURY_LSP_CPP',
    label: 'C/C++ IDE lane (clangd)',
    group: 'trust combo',
    kind: 'toggle',
    options: ['0'],
    defaultLabel: 'on',
    summary: 'real C/C++ IDE evidence — diagnostics with clang-tidy, rename, source↔header — through a clangd the harness finds for you',
    detail: {
      controls: 'The C/C++ language lane of the IDE bridge: finds a clangd (PATH · Xcode · Homebrew llvm), lazy-starts it on the first C/C++ file touched, and answers through the LSP tool. Needs nothing from the project — a compile database sharpens it (evidence on /health). Pairs with the Debug tool: real IDE evidence instead of guesses.',
      on: ['C/C++ files get diagnostics · rename · code actions · source↔header jumps', 'clang-tidy findings ride the diagnostics', 'no clangd installed ⇒ the lane simply stays quiet'],
      off: ['C/C++ files fall back to plain-text editing — no language server'],
    },
  },
  {
    env: 'MERCURY_SKIP_PERMISSIONS',
    label: 'Skip permissions at boot',
    group: 'trust combo',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'boot interactive sessions as if --dangerously-skip-permissions was passed — every tool call auto-approved',
    detail: {
      controls: "The env spelling of --dangerously-skip-permissions: interactive boots start in sovereign mode without typing the flag. Saving this row is the standing consent; the launch confirmation dialog and the root/sudo refusal still apply. Headless runs (-p) and daemon workers NEVER inherit it — their stricter permission floor stands.",
      on: ["interactive boots start with permissions bypassed (the crimson banner)", "the launch consent dialog still confirms once", "-p runs and daemon workers are unaffected"],
      off: ["permissions prompt normally; the CLI flag still works when passed by hand"],
    },
  },
  {
    env: 'MERCURY_AUTOPILOT',
    label: 'Autopilot tier mode',
    group: 'trust combo',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'a bypass-family mode where the agent may retune its own model/effort under rails — shift+tab past bypass to enter',
    detail: {
      controls: "Adds the Autopilot station to the shift+tab mode cycle (after Sovereign Mode): the same bypassed-permissions posture, plus the agent may retune its own model and reasoning effort mid-run via the SetTier tool — under mechanical rails (opus/sonnet only by default; 3-turn cooldown; 8 switches per session; every switch shown in the transcript and the mode band). Requires the same launch consent as Sovereign Mode (pair it with the skip-permissions row or the CLI flag).",
      on: ["the mode cycle gains ⌖ Autopilot (only when bypass is available)", "the agent may downshift for mechanical work and upshift for hard work — always visibly", "opus, sonnet, fable and fable51 are the self-selectable tiers; MERCURY_AUTOPILOT_MODELS narrows them"],
      off: ["no autopilot station, no SetTier tool — the plain cycle"],
    },
  },
  {
    env: 'MERCURY_TABULA_MINERVA',
    label: 'Minerva note curator',
    group: 'scale & spend',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'tidy the project notepad file (/note) once per boot with one pass of the Minerva model \u2014 the model you pin in /submodels (unset until you do); one billed call',
    detail: {
      controls: "The notepad curator: once per boot, one pass of the Minerva model reorganizes your project notepad journal (/note, its notepad.md on disk) \u2014 priorities, ordering, and one-line refinements beside your original wording. The Minerva model is the one you pin in /submodels \u2014 any row of the /model catalogue, carriers included; until you pin one Minerva is unset and the pass is skipped with that hint, spending nothing. One billed API call per boot once pinned; your notes never leave the machine otherwise. Minerva's room (/tabula) is separate: it refines your saved prompts only when you ask, one call per \u21b5.",
      on: ["one Minerva-model call per boot when the notepad changed", "notes get prioritized, ordered, and polished \u2014 originals always kept", "a rejected pass changes nothing (deterministic validation)"],
      off: ["the notepad stays manual \u2014 capture with /note, organize with /minerva <msg>", "Minerva's room (/tabula) still answers each \u21b5 on demand"],
    },
  },

  {
    env: 'MERCURY_MNEME',
    label: 'Project facts & decisions (MNEME)',
    group: 'memory & missions',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'long-term memory organized by topic — the agent saves and recalls notes across sessions',
    detail: {
      controls: "Long-term facts and decisions organized as hand-inspectable topic documents beside the always-on notes and lessons. A just-recorded fact is findable immediately; corrections supersede (the old value stays as history, never as current truth); maintenance runs itself at boot and turn end. Inspect, search, correct and maintain it all from /memory. Needs auto-memory on (it is, unless you disabled it). No model calls, no spend — capture is explicit.",
      on: ["the agent gains record/search/read/correct memory tools", "facts consolidate into topic documents automatically (boot + turn-end upkeep)", "/memory shows status, search, corrections and maintenance; /health has a Memory row"],
      off: ["nothing written, no memory tools added", "the always-on notes + experience-card lessons keep working"],
    },
  },
  {
    env: 'MERCURY_DAEDALUS',
    label: 'Repo generation (DAEDALUS)',
    group: 'memory & missions',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'build a whole repository with a team of agents working in parallel (real API cost; rides the THEMIS control plane, on by default)',
    detail: {
      controls: "Builds a whole repository from a brief using a team of agents \u2014 planners, developers, reviewers \u2014 SCALED to the brief (a tiny CLI gets 1 architect, not 4). Every launch is preview-first: a deterministic preflight shows the size class, roster, models and expected agent/token band with ZERO agents dispatched; the fleet runs only after you accept. Runs cost real API usage, shown before you commit. Rides Run discipline (THEMIS), which is on by default \u2014 only an explicit THEMIS off makes this unavailable.",
      on: ["a daedalus entry appears in /workflows", "preview-first: preflight (size class · roster · spend band) before ANY agent; accept launches", "runs on the THEMIS control plane (on unless you switched it off)", "models come from your choice \u2014 explicit, or the saved rows below (always shown at launch)"],
      off: ["not offered in /workflows", "no chance of accidental multi-agent spend"],
    },
  },
  {
    env: 'MERCURY_DAEDALUS_MODEL',
    label: 'Repo-gen planner model',
    group: 'memory & missions',
    kind: 'enum',
    options: ['opus', 'sonnet', 'fable', 'fable51'],
    defaultLabel: 'ask per dispatch',
    summary: 'your standing model choice for the planning roles — set it to skip the per-run question',
    detail: {
      controls: "Your standing model choice for repo generation's planning roles (architects, lead reviewer, QA). Injected mechanically at launch with its provenance named, validated against the current model catalogue, and shown in the launch consent \u2014 an explicit per-run choice always wins.",
      on: ["planning roles use this model automatically (named as the saved choice in the launch consent)", "shown at launch \u2014 pass a different model in the run's args to override"],
      off: ["the run asks for a model pick before launching"],
    },
  },
  {
    env: 'MERCURY_DAEDALUS_EXECUTOR_MODEL',
    label: 'Repo-gen builder model',
    group: 'memory & missions',
    kind: 'enum',
    options: ['opus', 'sonnet', 'fable', 'fable51'],
    defaultLabel: 'ask per dispatch',
    summary: 'your standing model choice for the building roles — set it to skip the per-run question',
    detail: {
      controls: "Your standing model choice for repo generation's building roles (developers, repair, integrator). Injected mechanically at launch with its provenance named, validated against the current model catalogue, and shown in the launch consent \u2014 an explicit per-run choice always wins.",
      on: ["building roles use this model automatically (named as the saved choice in the launch consent)", "shown at launch \u2014 pass a different model in the run's args to override"],
      off: ["the run asks for a model pick before launching"],
    },
  },
  {
    env: 'MERCURY_LAUNCH_RIPPLE',
    label: 'Launch animation',
    group: 'miscellaneous',
    kind: 'toggle',
    options: ['0'],
    defaultLabel: 'on',
    summary: 'the splash ripple on launch — turn off for the fastest boot handoff',
    detail: {
      controls: 'The circuit-trace ripple the splash plays while handing the session over. Off is the fast-boot lever: the splash paints once and hands over immediately. Reduced-motion (MERCURY_REDUCED_MOTION=1) also suppresses it; MERCURY_SPLASH=off skips the splash entirely.',
      on: ['the authored launch ripple on truecolor terminals'],
      off: ['no animation — the fastest handoff to the session'],
    },
  },
  {
    env: 'MERCURY_GODOT',
    label: 'Godot language lanes',
    group: 'miscellaneous',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'GDScript IDE + debugger through your running Godot editor — outline, member search, navigation, breakpoints',
    detail: {
      controls: 'Arms both Godot lanes: the GDScript language server (outline · member search · navigation — it lives INSIDE the Godot editor, reached over a loopback bridge on :6005) and the godot debug adapter (:6006) for the Debug tool. Activates only in a project with a project.godot, and the editor must be open — a closed editor answers with a teaching note, never a hang. Pairs with the Godot control surface (VULCAN) below for full editor control.',
      on: ['.gd files get the GDScript IDE ops through the LSP tool', "the Debug tool gains the 'godot' adapter (breakpoints in the running editor)", 'no project.godot or no running editor ⇒ an honest teaching note'],
      off: ['no Godot servers are ever dialed — identical to a build without it'],
    },
  },
  {
    env: 'MERCURY_GODOT_TOOLS',
    label: 'Godot control surface (VULCAN)',
    group: 'miscellaneous',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'full editor control for Godot projects — scenes, nodes, resources, play-testing, runtime inspection, input simulation (163 ops)',
    detail: {
      controls: "The agent drives your running Godot editor directly: scene and node editing (every change is one Ctrl+Z undo step), scripts, resources, animation, physics, audio, tilemaps, shaders — plus play-testing with live game inspection and input simulation. Arming it also shifts agent behavior: sessions and spawned agents learn to prefer editor state over hand-editing scene files. Needs the bundled mercury_vulcan addon installed in the project (the tool installs it on ask) and the editor open. Local and sandboxed: a token-authed loopback connection only; running code or simulating input always asks permission first. Pairs with the Godot language lanes above (symbols + breakpoints stay with the LSP/Debug tools).",
      on: ['the Godot tool joins the catalog in Godot projects (163 editor ops + extras)', 'reads are free; edits ask like file edits and are undoable in the editor; play/input/execute always ask', 'agents shift behavior: editor-first workflow, play-test natively, memory keeps project facts'],
      off: ['no Godot tool, no connection, no addon writes — identical to an unarmed build'],
    },
  },
  {
    env: 'MERCURY_UNITY',
    label: 'Unity dev lanes',
    group: 'miscellaneous',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'C# IDE + attach-to-editor debugging + editor bridge (play/scenes/tests) + headless test/build profiles for Unity projects — nothing is ever installed or run for you without asking',
    detail: {
      controls: "Arms the Unity lanes in a project with Assets/ + ProjectSettings/: the C# language server lane (your own csharp-ls or OmniSharp from PATH — never auto-installed; doctor teaches the install line when absent), the Debug tool's `unity` adapter (attaches to your RUNNING editor via the official Unity VS Code extension's adapter — the editor hosts the debuggee, so every gesture is an attach), the `Unity` tool driving your running editor over a token-authed loopback bridge (play mode, scenes, hierarchy, console, Test Runner — needs the bundled bridge package installed in the project, which the tool does on ask; play/test gestures always ask permission), and headless -batchmode test/build launch profiles the tool hands you to run yourself. Unity's own licensing applies to headless editor runs; if a run fails with Unity's licensing error, activating a license is yours to do (Unity Hub or -serial) — Mercury never checks or manages licenses, and never launches or installs the editor.",
      on: ['.cs files in Unity projects get IDE ops through the LSP tool (csharp-ls/OmniSharp from PATH)', "the Debug tool gains the 'unity' adapter — breakpoints in your running editor (port from Library/EditorInstance.json)", "the `Unity` tool joins the catalog in Unity projects — play/scenes/hierarchy/console/test runs through your running editor (bridge package installed on ask; reads are free, everything else asks)", 'headless test/build profiles appear; running them stays your act (the exact command is printed, license disclaimer included)'],
      off: ['no Unity surface exists — identical to a build without it'],
    },
  },
  {
    env: 'MERCURY_BLENDER',
    label: 'Blender dev lanes',
    group: 'miscellaneous',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: '.blend awareness + Blender bridge (scene/render/python) + headless render/python profiles + the debugpy attach recipe — Blender located (app bundle counts), never installed, launched, or enabled for you',
    detail: {
      controls: 'Arms the Blender lanes: .blend discovery (bounded), the app located your way — a PATH blender, /Applications/Blender.app (the normal Mac install), Program Files, or a MERCURY_BLENDER_BIN pin — with its version probed, headless --background render/python launch profiles the tool hands you to run yourself (arguments in documented order — output before frame), the debugpy attach recipe: one line starts a listener inside Blender, then the Debug tool attaches over the landed debugpy road (the bundled debugpy serves when this build carries it), and the `Blender` tool driving your running Blender over a token-authed loopback bridge (scene/objects truth, blend opens, still renders, report tail, python_run — needs the bundled add-on installed to the user addon home, which the tool does on ask, and ENABLED in Blender\'s Preferences, which stays your act; python_run and renders always ask permission). Mercury never installs, launches, or enables Blender or its add-ons.',
      on: ['doctor gains the Blender lane row (path + version, or the honest install line)', 'headless render/python profiles appear; running them stays your act (the exact command is printed)', 'the debug recipe row teaches listen-then-attach (breakpoints in your addon/script files)', 'the `Blender` tool joins the catalog beside .blend files — scene/objects/render truth, blend opens, still renders, report tail, python_run through your running Blender (add-on installed on ask, enabled by you; reads are free, everything else asks)'],
      off: ['no Blender surface exists — identical to a build without it'],
    },
  },
  {
    env: 'MERCURY_ASEPRITE',
    label: 'Aseprite dev lanes',
    group: 'miscellaneous',
    kind: 'toggle',
    options: ['1'],
    defaultLabel: 'off',
    summary: 'sprite awareness + the Aseprite batch door (sprite census, PNG/GIF/sprite-sheet exports, new sprites, Lua scripts) — Aseprite located (Steam and itch installs count), never installed or launched as a GUI for you',
    detail: {
      controls: 'Arms the Aseprite lanes: .aseprite/.ase discovery (bounded), the app located your way — a PATH aseprite, /Applications/Aseprite.app (the direct download), the Steam library, the win32 installer/itch homes, or a MERCURY_ASEPRITE_BIN pin (the road for source builds) — with its version probed, and the `Aseprite` tool driving the app\'s own batch mode: sprite census (layers, tags, frames, size), exports with the real CLI options (scaling, layer/tag selection, split files, sprite-sheet layouts with JSON metadata), new sprites, and Lua scripts. Every operation is a bounded background run of `aseprite -b` — the GUI is never started. Exports and new sprites ask permission naming the destination; running a script always asks (it is code). Mercury never installs or launches Aseprite for you.',
      on: ['the `Aseprite` tool joins the catalog beside sprite files, or anywhere the app is located (creating from nothing works)', 'sprite census reads are free; exports and new sprites ask naming their files; Lua scripts always ask', 'no Aseprite on the box ⇒ honest teaching notes naming every install road'],
      off: ['no Aseprite surface exists — identical to a build without it'],
    },
  },
  {
    env: 'MERCURY_CAP_FAILOVER',
    label: 'Cap failover posture',
    group: 'miscellaneous',
    kind: 'enum',
    options: ['off', 'auto'],
    defaultLabel: 'offer',
    summary:
      'when the active usage window caps out: the SLOT rung always asks first (a one-key switch to the same family\'s other signed-in slot with headroom; auto switches it unattended) · offer (default) adds the one-keypress cross-family handoff card — nothing moves without your confirm · off waits for reset instead · auto hands off unattended and returns on reset',
    detail: {
      controls:
        "What happens when the active usage window runs out mid-work. TWO rungs. The SLOT rung (within the family — Anthropic's sign-in↔managed key, OpenAI's subscription↔API key): whenever the walled family's OTHER slot is signed in with headroom, the wall presents a one-key slot-switch card at EVERY posture — off included (the wall is never a dead end); at auto the slot switches unattended, receipted on the wall row and in the slot state. Nothing signs out; the next turn rides the other slot. The CROSS-FAMILY rung: offer (the default) — a usage warning or a capped window presents a one-keypress card (window · reset time · spend posture) that opens the model-transition preview; confirming hands the session to the readiest usable lane of the other families — OpenAI first, then the whole readiness-checked catalogue — at a safe boundary; no usable second lane, no card. off — never leaves the family, never offers; work waits for the reset. auto: a capped window hands off unattended (daemon/overnight runs) — warnings still show the visible offer. Return is symmetric: once the Claude window resets, the same posture offers or executes the way home. A slot switch back is the same one key (or /router source) once the walled window resets.",
      on: [
        'offer (the default): warnings and caps present the one-keypress handoff card — nothing moves without your confirm, and no card appears without a usable second lane',
        'auto: a walled slot switches to its family sibling unattended, and a capped family hands off cross-family at a safe boundary — receipted both ways',
        'on window reset, the same posture brings work home to the subscription lane',
      ],
      off: [
        'the slot rung still ASKS — a walled slot with a signed-in sibling gets the one-key switch card (the wall is never a dead end)',
        'cross-family: never switches, never offers — a capped family waits for its reset (the pre-change default, selectable exactly)',
      ],
    },
  },
  {
    env: 'MERCURY_CONCOURSE',
    label: 'Session Concourse at boot',
    group: 'miscellaneous',
    kind: 'enum',
    options: ['auto', 'always'],
    defaultLabel: 'off',
    summary:
      'where a plain boot LANDS — the Concourse itself stays on either way: Off lands the Boot face · Auto lands the Concourse board when sessions are live or waiting · Always makes the board the boot home',
    detail: {
      controls:
        'Where a boot lands — never whether the Session Concourse exists (that is the persisted `--concourse-off` switch; the Concourse stays a first-class screen whatever this row says). Off (default): a plain `mercury` launch lands on the Boot face, with the Concourse one shift+← from the chat and a face row away; a prompt argument or `--continue`/`--resume` goes straight to the chat; existing background sessions are untouched. Auto: the boot lands on the Concourse board exactly when it has something to show (more than one live session, or a session waiting on you); otherwise the Boot face as usual. Always: the Concourse board is the boot home. Resolution reads one bounded records summary before the chat mounts — never a daemon call, never fleet discovery.',
      on: [
        'auto: >1 live session or a waiting question boots into the Concourse board',
        'always: every boot lands on the Concourse board (the chat one shift+→ away)',
        'existing sessions are never cancelled, hidden or mutated by any choice',
      ],
      off: ['plain launches land the Boot face; the Concourse stays on — shift+← from the chat (or its face row) opens the board'],
    },
  },
] as const

export const COMMAND_SETTINGS_ROWS: readonly MenuRow[] = [
  {
    env: 'MERCURY_CACHE_TTL',
    label: 'Anthropic prompt-cache TTL pin',
    group: 'command:/caching',
    kind: 'enum',
    options: ['5m', '1h'],
    defaultLabel: 'adaptive',
    summary:
      'how long Anthropic keeps your conversation cached between prompts — Claude-family calls only; adaptive picks for you; set from /caching',
  },
] as const

export function allSettingRows(): readonly MenuRow[] {
  return [...STARTUP_MENU, ...COMMAND_SETTINGS_ROWS]
}

const RETIRED_MENU_ENV: ReadonlySet<string> = new Set(
  'MERCURY_ENGINES MERCURY_HELM_HOME MERCURY_HELM_CONSOLE MERCURY_DECK_COMPANION MERCURY_CURSUS MERCURY_PARTY MERCURY_ROOM_REMOTE'.split(' '),
)

export function menuRowChoices(row: MenuRow): MenuChoice[] {
  const rest: MenuChoice[] = row.options.map(v => ({
    value: v,
    label: row.kind === 'toggle' ? (v === '0' ? 'off' : 'on') : v,
  }))
  return [{ value: null, label: `default (${row.defaultLabel})` }, ...rest]
}


export const BOOT_ENV_VERSION = 1

export function bootEnvPath(): string {
  return join(getMercuryHome(), 'boot-env.json')
}

export interface BootEnvApplyResult {
  applied: Array<{ env: string; value: string }>
  envWins: string[]
  refused: Array<{ key: string; reason: string }>
  retired: string[]
}

const EMPTY: BootEnvApplyResult = { applied: [], envWins: [], refused: [], retired: [] }

let lastApplyResult: BootEnvApplyResult | null = null

export function bootEnvAppliedKeys(): ReadonlySet<string> {
  return new Set((lastApplyResult?.applied ?? []).map(a => a.env))
}

export function applyBootMenuEnv(
  path: string = bootEnvPath(),
  env: NodeJS.ProcessEnv = process.env,
): BootEnvApplyResult | null {
  if (!flagEnabled('MERCURY_ENTER_MENU')) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const result: BootEnvApplyResult = { applied: [], envWins: [], refused: [], retired: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    result.refused.push({ key: '(file)', reason: 'not valid JSON' })
    return surfaced(result, path)
  }
  const o = parsed as { version?: unknown; env?: unknown }
  if (!o || typeof o !== 'object' || o.version !== BOOT_ENV_VERSION || o.env === null || typeof o.env !== 'object' || Array.isArray(o.env)) {
    result.refused.push({ key: '(file)', reason: `expected {version:${BOOT_ENV_VERSION}, env:{…}}` })
    return surfaced(result, path)
  }
  const byEnv = new Map<string, MenuRow>()
  for (const r of allSettingRows()) {
    for (const spelling of flagSpellings(r.env)) byEnv.set(spelling, r)
  }
  const appliedRows = new Set<string>()
  for (const [key, value] of Object.entries(o.env as Record<string, unknown>)) {
    const row = byEnv.get(key)
    if (!row) {
      if (RETIRED_MENU_ENV.has(key)) {
        result.retired.push(key)
        continue
      }
      result.refused.push({ key, reason: 'not a startup-menu row (anti-smuggling: unregistered keys are never applied)' })
      continue
    }
    if (appliedRows.has(row.env)) continue
    appliedRows.add(row.env)
    if (typeof value !== 'string' || !menuRowChoices(row).some(c => c.value === value)) {
      result.refused.push({ key, reason: `value ${JSON.stringify(value)} not among the row's declared choices` })
      continue
    }
    if (flagSpellings(row.env).some(sp => env[sp] !== undefined)) {
      result.envWins.push(row.env)
      continue
    }
    stampFlagOnEnv(env, row.env, value)
    result.applied.push({ env: row.env, value })
  }
  if (result.applied.length > 0 && themisActive()) {
    void import('./themis/auditChain.js')
      .then(m =>
        m.appendAuditRow({
          actor: 'boot',
          action: 'boot-env-applied',
          details: result.applied.map(a => `${a.env}=${a.value}`).join(' '),
        }),
      )
      .catch(() => {})
  }
  return surfaced(result, path)
}

function surfaced(result: BootEnvApplyResult, path: string): BootEnvApplyResult {
  lastApplyResult = result
  if (result.refused.length > 0) {
    for (const r of result.refused) {
      addBootNote('warn', `boot-env refused ${r.key} — ${r.reason} · ${path}`)
    }
  }
  return result
}


export function readBootEnvChoices(
  path: string = bootEnvPath(),
): Record<string, string> | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown
      env?: unknown
    }
    if (!o || typeof o !== 'object' || o.version !== BOOT_ENV_VERSION) return null
    if (o.env === null || typeof o.env !== 'object' || Array.isArray(o.env)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

export function writeBootEnvChoice(
  envKey: string,
  value: string | null,
  path: string = bootEnvPath(),
): { ok: true } | { ok: false; reason: string } {
  const row = allSettingRows().find(r => r.env === envKey)
  if (!row) return { ok: false, reason: `${envKey} is not a registered setting row` }
  if (value !== null && !menuRowChoices(row).some(c => c.value === value)) {
    return {
      ok: false,
      reason: `value ${JSON.stringify(value)} not among the row's declared choices`,
    }
  }
  const saved = readBootEnvChoices(path) ?? {}
  const env: Record<string, string> = {}
  for (const r of allSettingRows()) {
    const sp = flagSpellings(r.env).find(s => saved[s] !== undefined)
    if (sp !== undefined) env[r.env] = saved[sp]!
  }
  if (value === null) delete env[row.env]
  else env[row.env] = value
  const committed = saveBootDefaultsProfile(env, path)
  return committed.ok ? { ok: true } : { ok: false, reason: committed.reason }
}


export interface BootDefaultsProfileV1 {
  version: typeof BOOT_ENV_VERSION
  savedAt: string
  env: Record<string, string>
  revision: number
  digest: string
  receipt: string
}

export function profileDigestOf(env: Record<string, string>): string {
  const canonical = Object.keys(env)
    .sort()
    .map(k => `${k}=${env[k]}`)
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function readBootDefaultsProfile(path: string = bootEnvPath()): BootDefaultsProfileV1 | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BootDefaultsProfileV1> & { env?: unknown }
    if (parsed.version !== BOOT_ENV_VERSION || typeof parsed.env !== 'object' || parsed.env === null) return null
    const env = Object.fromEntries(
      Object.entries(parsed.env as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    )
    return {
      version: BOOT_ENV_VERSION,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      env,
      revision: typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) ? parsed.revision : 0,
      digest: typeof parsed.digest === 'string' && parsed.digest.length > 0 ? parsed.digest : profileDigestOf(env),
      receipt: typeof parsed.receipt === 'string' ? parsed.receipt : '',
    }
  } catch {
    return null
  }
}

export function saveBootDefaultsProfile(
  env: Record<string, string>,
  path: string = bootEnvPath(),
  opts?: {
    existingSessionsUnchanged?: number
  },
): { ok: true; revision: number; digest: string; receipt: string } | { ok: false; reason: string } {
  for (const [key, value] of Object.entries(env)) {
    const row = allSettingRows().find(r => flagSpellings(r.env).includes(key))
    if (!row) return { ok: false, reason: `${key} is not a registered setting row` }
    if (!menuRowChoices(row).some(c => c.value === value)) {
      return { ok: false, reason: `value ${JSON.stringify(value)} not among ${row.env}'s declared choices` }
    }
  }
  const paired: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const row = allSettingRows().find(r => flagSpellings(r.env).includes(key))!
    for (const sp of flagSpellings(row.env)) paired[sp] = value
  }
  const previous = readBootDefaultsProfile(path)
  const revision = (previous?.revision ?? 0) + 1
  const digest = profileDigestOf(paired)
  const unchanged =
    opts?.existingSessionsUnchanged !== undefined && opts.existingSessionsUnchanged >= 0
      ? `${opts.existingSessionsUnchanged} existing session${opts.existingSessionsUnchanged === 1 ? '' : 's'} unchanged`
      : 'existing sessions unchanged'
  const receipt = `Saved as future defaults · applies to sessions created after revision ${revision} · ${unchanged}`
  const profile: BootDefaultsProfileV1 = {
    version: BOOT_ENV_VERSION,
    savedAt: new Date().toISOString(),
    env: paired,
    revision,
    digest,
    receipt,
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return { ok: true, revision, digest, receipt }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}


export interface EffectiveSettingRow {
  env: string
  value: string | null
  source: 'process-env' | 'profile' | 'default'
  applicationClass: 'new-session'
}

export interface SessionEffectiveSettingsSnapshotV1 {
  schema: 1
  snapshotId: string
  sessionId: string
  profileRevision: number
  profileDigest: string
  resolvedAt: number
  rows: EffectiveSettingRow[]
}

export function resolveEffectiveSettingsSnapshot(args: {
  sessionId: string
  path?: string
  env?: NodeJS.ProcessEnv
}): SessionEffectiveSettingsSnapshotV1 {
  const processEnv = args.env ?? process.env
  const profile = readBootDefaultsProfile(args.path ?? bootEnvPath())
  const rows: EffectiveSettingRow[] = STARTUP_MENU.map(row => {
    const spellings = flagSpellings(row.env)
    const envSpelling = spellings.find(sp => processEnv[sp] !== undefined)
    if (envSpelling !== undefined) {
      return { env: row.env, value: processEnv[envSpelling] ?? null, source: 'process-env', applicationClass: 'new-session' }
    }
    const profSpelling = profile ? spellings.find(sp => profile.env[sp] !== undefined) : undefined
    if (profile && profSpelling !== undefined) {
      return { env: row.env, value: profile.env[profSpelling] ?? null, source: 'profile', applicationClass: 'new-session' }
    }
    return { env: row.env, value: null, source: 'default', applicationClass: 'new-session' }
  })
  const revision = profile?.revision ?? 0
  const digest = profile?.digest ?? profileDigestOf({})
  const rowsDigest = profileDigestOf(
    Object.fromEntries(rows.map(r => [r.env, `${r.source}:${r.value ?? ''}`])),
  )
  return {
    schema: 1,
    snapshotId: `snap-r${revision}-${rowsDigest.slice(0, 12)}`,
    sessionId: args.sessionId,
    profileRevision: revision,
    profileDigest: digest,
    resolvedAt: Date.now(),
    rows,
  }
}


export interface ConfigMenuRow {
  id: string
  label: string
  group: string
  options: readonly string[]
  defaultLabel: string
  summary: string
  detail?: {
    controls: string
    on: readonly string[]
    off: readonly string[]
  }
}

export const COORDINATOR_MENU_ROW: ConfigMenuRow = {
  id: 'coordinator',
  label: 'Coordinator',
  group: 'miscellaneous',
  options: ['on', 'off'],
  defaultLabel: 'off',
  summary:
    'the concourse coordinator — on, it launches, watches and reconciles your sessions; off, the composer starts sessions directly',
  detail: {
    controls:
      "Whether the concourse coordinator manages your sessions. on: you talk to it in the concourse — it launches, watches, queues and reconciles sessions in plain words. off: the concourse composer starts sessions directly — your text becomes the session's task and its title. Applies at the coordinator's next turn.",
    on: [
      'the concourse pane converses — launch, pause, relay and reconcile by asking',
      'needs-you questions are relayed into the chat and carried back',
    ],
    off: [
      'typing in the concourse composer starts a session directly',
      'the board, mirror and manual start keep working',
    ],
  },
}

export type CoordinatorMenuChoice = 'on' | 'off'

export async function readCoordinatorMenuChoice(): Promise<CoordinatorMenuChoice> {
  const { getGlobalConfig } = await import('../utils/config.js')
  return getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted' ? 'on' : 'off'
}

export async function writeCoordinatorMenuChoice(
  choice: CoordinatorMenuChoice,
): Promise<import('../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1> {
  const { switchCoordinatorMode } = await import('../services/concourse/coordinatorModels.js')
  return switchCoordinatorMode(choice === 'on' ? 'agent-assisted' : 'rules-only')
}


export type ExplicitApplyOutcome = 'applied' | 'queued' | 'refused' | 'no-change'

export interface ExplicitApplyReceipt {
  env: string
  outcome: ExplicitApplyOutcome
  target: string | null
  reason: string
}

export function evaluateExplicitApply(
  snapshot: SessionEffectiveSettingsSnapshotV1,
  profile: BootDefaultsProfileV1 | null,
): ExplicitApplyReceipt[] {
  return snapshot.rows.map(row => {
    const spellings = flagSpellings(row.env)
    const profSpelling = profile ? spellings.find(sp => profile.env[sp] !== undefined) : undefined
    const target = profile && profSpelling !== undefined ? (profile.env[profSpelling] ?? null) : null
    if (row.source === 'process-env') {
      return {
        env: row.env,
        outcome: 'refused',
        target,
        reason: 'pinned by the real environment — explicit env always wins (the :634 law); unset it and restart to follow the profile',
      } satisfies ExplicitApplyReceipt
    }
    if ((row.value ?? null) === target) {
      return {
        env: row.env,
        outcome: 'no-change',
        target,
        reason: 'already at the profile value — nothing to apply',
      } satisfies ExplicitApplyReceipt
    }
    return {
      env: row.env,
      outcome: 'refused',
      target,
      reason: `applies at session creation (application class: ${row.applicationClass}) — the session keeps its captured snapshot r${snapshot.profileRevision}; recreate or resume-fresh to receive the newer profile`,
    } satisfies ExplicitApplyReceipt
  })
}
