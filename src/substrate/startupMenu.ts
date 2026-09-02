/* ============================================================================
   STARTUP MENU — the enter-screen config registry + boot-env applier
   (paper-triad Slice D, task #25).

   ONE typed table (STARTUP_MENU) is the single source of truth for what the
   Mercury enter screen's `m` menu offers. The splash is a standalone child
   process (the launcher runs $MERCURY_HOME/splash.mjs — no src imports), so
   the registry is BAKED into assets/splash/mercury-splash.mjs between
   MERCURY-MENU-START/END markers by scripts/splash/bake-menu.mjs; its
   `--check` mode fails the splash suite on any registry↔splash drift (the
   regen-wrapper pattern). Choices flow back through a FILE:

     $MERCURY_HOME/boot-env.json   { version: 1, savedAt, env: {KEY: value} }

   applyBootMenuEnv() (called early in main(), before anything latches env)
   applies that file under four hard rules:
     1. ANTI-SMUGGLING — only registered setting rows are applied: the menu
        rows (STARTUP_MENU) plus the command-owned rows (COMMAND_SETTINGS_ROWS
        — settings whose writer is a command surface, e.g. /caching's TTL
        dial); PATH/NODE_OPTIONS/anything unregistered is refused + surfaced.
        Every row's env must itself be a registered flag (prove-startup-menu
        pins rows ⊆ FLAG_REGISTRY), so the file can only ever set known knobs.
     2. VALUE VALIDATION — the value must be one of the row's declared
        choices (menuRowChoices); anything else is refused + surfaced.
     3. EXPLICIT ENV WINS — a key already present in the real environment is
        NEVER overwritten (the file is a default layer, not an override).
     4. AUDITED — when THEMIS is on after application, an audit row records
        what was applied (actor 'boot').

   Consent model (the CREW precedent): the file exists only because the
   operator set a row in the menu — WRITE-THROUGH: cycling a
   row saves it immediately (the visible menu state IS the saved state; the
   old only-`s`-saves grammar silently discarded a row that still read as
   changed). Per-billed-call consent downstream is untouched. MERCURY_ENTER_MENU
   (default-on, tier infra) is only the kill — `=0` ignores the file
   entirely, and a missing file is a no-op. Both no-op paths are
   byte-identical boots.
   ============================================================================ */

import { getMercuryHome } from '../utils/envUtils.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { flagEnabled, flagEnv, flagSpellings, stampFlagOnEnv } from './flagRegistry.js'
import { addBootNote } from './bootNotes.js'
import { themisActive } from './themis/level.js'

export interface MenuRow {
  /** The env key this row sets — MUST be a registered flag (proof-pinned). */
  env: string
  label: string
  /** Visual grouping in the menu pane. */
  group: string
  /** 'toggle' cycles default↔the single option; 'enum' cycles default→each
   *  option; 'string' is reserved (no v1 rows — free text needs a validator). */
  kind: 'toggle' | 'enum' | 'string'
  /** The explicit NON-DEFAULT values this row may set. Explicit per row —
   *  deriving them from the flag kind is wrong for 'value' flags (some arm
   *  with '1' while others disable with '0'). */
  options: readonly string[]
  /** What unset means (shown as the default choice's label). */
  defaultLabel: string
  summary: string
  /** SETTING DETAIL pane content (boot-menu redesign): what the
   *  knob controls + the honest effect lists for its enabled/disabled states.
   *  Authored per row and BAKED into the splash beside the choices. */
  detail?: {
    controls: string
    on: readonly string[]
    off: readonly string[]
  }
}

export interface MenuChoice {
  /** null = leave the key unset (the code default). */
  value: string | null
  label: string
}

/**
 * v1 rows — the paper-triad knobs (the reason this menu exists) + the
 * startup-worthy harness knobs. Subsystems self-register by adding rows;
 * rebake the splash (scripts/splash/bake-menu.mjs) after any change.
 */
export const STARTUP_MENU: readonly MenuRow[] = [
  // The declutter: the cockpit combo (Helm
  // home, Helm console), the session-companion layer, and the engines
  // arming row LEFT the menu — those features ship default-ON and their
  // off-switches are their own flags/commands; the menu keeps only what the
  // product genuinely asks at boot. Saved choices for retired rows drop on
  // apply (RETIRED_MENU_ENV below).
  // The TRUST COMBO: wards stop bad calls, the debugger earns
  // the evidence. (The self-check stop gate that completed the trio was
 // RETIRED — current-generation models self-verify,
  // and bolt-on re-check scaffolding over-verifies; the run-evidence hook
  // owns evidence-based stop decisions.)
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
  // Run discipline joined the trust combo when it went default-ON (operator
  // ruling) — a GLOBAL posture beside wards + the debugger, no
  // longer an opt-in parked with the memory/mission arms.
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
  // IDE language lanes (the operator's ask: "where's the opt-in?" — the
  // boot menu IS the arm surface for opt-ins; these two were env-only).
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
  // Permission-posture rows: both default-OFF,
  // both armed HERE — the saved boot-env row IS the standing consent. The
  // skip-permissions row is the env spelling of the CLI flag; autopilot
  // builds on it (same eligibility gate, plus the tier controls).
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
  // The Anthropic prompt-cache TTL row LEFT the menu (operator
  // ruling): a one-family dial held neutral boot-menu real
  // estate — the control plane keeps global postures only, and cache tuning
  // is a mid-session spend thought. The SETTING SURVIVES: the /caching
  // command surface is its writer now (COMMAND_SETTINGS_ROWS below), the
  // saved boot-env choice keeps applying at boot, and CP-A's per-family
  // wording carried into that surface's copy verbatim.
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
  // Miscellaneous — engine-specific opt-in surfaces (operator directive
  // The fast-boot control is a PRODUCT row, not
  // an env workaround — the ONE deliberate promotion of a
  // pre-boot registry flag into the menu.
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
  // Godot opt-ins live together here; each row's detail is the
  // explanation surface).
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
  // The engine opt-ins continue: Unity + Blender live beside the Godot rows
  // (operator arming ruling — same subcategory, default OFF).
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
  // The usage-limit-relay row LEFT the menu (telemetry-truth lane,
  //) and the subsystem itself is deleted (account-slot
  // simplification ruling): no rotation or switching machinery;
  // saved boot choices drop via RETIRED_MENU_ENV like every retired row.
  {
    // The cap-survival posture — the decision core is
    // services/capFailover.ts and every switch settles through the ONE
    // model-selection owner. DEFAULT offer (FN-013 MODEL-05, the
    // operator-accepted release-note change): the wall presents the
    // one-keypress card when a usable second lane exists — an offer never
    // switches anything. Explicit off restores the old fully-inert
    // cross-family posture; auto is the explicit unattended arming.
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
 // ── the Session Concourse boot policy. One
  // enum row over the registered MERCURY_CONCOURSE flag; Off is the
  // leave-unset default (the MenuRow law: options carry non-default values
  // only). Auto reads ONLY the bounded records summary at resolution —
  // never a daemon RPC; Off never cancels, hides or mutates
  // existing workers (the policy gates ENTRY, not the fleet).
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

/**
 * COMMAND-OWNED SETTING ROWS — rows that ride boot-env.json under the FULL
 * menu-row law (registered flag · declared choices · anti-smuggling ·
 * explicit-env-wins · the profile receipt) but are NOT painted in the boot
 * menu: their writer is a command surface, not the enter screen (operator
 * ruling — the control plane keeps global postures only). The
 * splash bake and every menu paint iterate STARTUP_MENU alone; the applier
 * and the profile writers honour the UNION, so a saved choice for one of
 * these applies at boot exactly as it always did.
 *
 *   MERCURY_CACHE_TTL — the Anthropic prompt-cache TTL pin. Writer: the
 *   /caching surface (its Anthropic row's dial). The per-family wording
 *   lives in that surface's copy.
 */
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

/** Every row the boot-env file may carry — the applier/writer union. */
export function allSettingRows(): readonly MenuRow[] {
  return [...STARTUP_MENU, ...COMMAND_SETTINGS_ROWS]
}

/** Rows RETIRED from the menu (the declutter: cockpit combo +
 *  session companion ship default-ON; the engines arming row retired with
 *  its gate; the usage-relay row left with its subsystem's retirement —
 *  telemetry-truth lane, same day). A saved boot-env choice for one of these
 *  is DROPPED on apply — the feature's own flag/command is the off-switch
 *  now — and pruned at the next profile save (the writer rebuilds from live
 *  rows). Space-joined so the names never read as live flag references (the
 * registry law). */
const RETIRED_MENU_ENV: ReadonlySet<string> = new Set(
  'MERCURY_ENGINES MERCURY_HELM_HOME MERCURY_HELM_CONSOLE MERCURY_DECK_COMPANION MERCURY_CURSUS MERCURY_PARTY MERCURY_ROOM_REMOTE'.split(' '),
)

/** The legal choice set for a row — [leave-unset] + the declared options.
 *  ONE resolver shared by the bake, the applier, and the proofs. */
export function menuRowChoices(row: MenuRow): MenuChoice[] {
  const rest: MenuChoice[] = row.options.map(v => ({
    value: v,
    label: row.kind === 'toggle' ? (v === '0' ? 'off' : 'on') : v,
  }))
  return [{ value: null, label: `default (${row.defaultLabel})` }, ...rest]
}

// ── the boot-env file ────────────────────────────────────────────────────────

export const BOOT_ENV_VERSION = 1

/** The boot-env file lives in THE resolved config home — one resolver, one
 *  home, so it can never sit in a different home than every other config
 *  surface. */
export function bootEnvPath(): string {
  return join(getMercuryHome(), 'boot-env.json')
}

export interface BootEnvApplyResult {
  /** Keys actually written into process.env. */
  applied: Array<{ env: string; value: string }>
  /** Keys skipped because the real environment already set them (env wins). */
  envWins: string[]
  /** Keys/values rejected (unregistered key, foreign value, bad shape). */
  refused: Array<{ key: string; reason: string }>
  /** Saved choices for RETIRED menu rows — dropped quietly (not smuggling;
   *  the row simply left the menu), pruned at the next profile save. */
  retired: string[]
}

const EMPTY: BootEnvApplyResult = { applied: [], envWins: [], refused: [], retired: [] }

// The last apply result, kept so downstream truth surfaces (the readiness
// collector / capability center env section) can attribute a set flag to the
// boot file vs the real environment. Null until applyBootMenuEnv runs.
let lastApplyResult: BootEnvApplyResult | null = null

/** Keys applyBootMenuEnv actually wrote this process (source attribution). */
export function bootEnvAppliedKeys(): ReadonlySet<string> {
  return new Set((lastApplyResult?.applied ?? []).map(a => a.env))
}

/**
 * Apply the operator's saved enter-menu choices. `MERCURY_ENTER_MENU=0`
 * or a missing/unreadable file ⇒ null (byte-identical boot, nothing surfaced).
 * Refusals are surfaced on stderr in ONE line — never silent, never fatal.
 */
export function applyBootMenuEnv(
  path: string = bootEnvPath(),
  env: NodeJS.ProcessEnv = process.env,
): BootEnvApplyResult | null {
  if (!flagEnabled('MERCURY_ENTER_MENU')) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null // no file ⇒ the operator never saved a menu ⇒ no-op
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
  // Rows key on the canonical MERCURY_* spelling; a boot-env.json saved
  // earlier may carry the retired spelling — both resolve the row
  // (the ONE bounded migration read for this file format).
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
    // a both-spelling save (the transitional writer) applies ONCE per row
    if (appliedRows.has(row.env)) continue
    appliedRows.add(row.env)
    if (typeof value !== 'string' || !menuRowChoices(row).some(c => c.value === value)) {
      result.refused.push({ key, reason: `value ${JSON.stringify(value)} not among the row's declared choices` })
      continue
    }
    if (flagSpellings(row.env).some(sp => env[sp] !== undefined)) {
      result.envWins.push(row.env) // explicit real env ALWAYS outranks the file
      continue
    }
    stampFlagOnEnv(env, row.env, value)
    result.applied.push({ env: row.env, value })
  }
  // THEMIS audit (post-application, so a MERCURY_THEMIS row just applied counts):
  // fire-and-forget — the audit sink must never slow or break boot.
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
    // Refusals are DIAGNOSTIC, not boot chrome (operator ruling —
    // a raw stderr line above the setup UI was backend plumbing leaking onto
    // the operator surface). They become BOOT NOTES: the setup card's
    // disclosure row + /doctor carry them; lastApplyResult keeps the boot
    // menu's own view; the debug log gets the raw line.
    for (const r of result.refused) {
      addBootNote('warn', `boot-env refused ${r.key} — ${r.reason} · ${path}`)
    }
  }
  return result
}

// ── in-session boot-pref read/write ──────────────────────────────────────────
// The in-process Boot Settings face's "use at startup" writes (feel-pass
// slice 2): boot preference and session state must never overwrite each other
// implicitly, so the face reads/writes the SAVED file explicitly through the
// same registry rules the applier enforces. Same consent model as the menu —
// a write here is the operator pressing the key.

/** The saved boot-env choices, or null when no valid file exists. */
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

/**
 * Write ONE registered row's saved choice (value null clears the key).
 * Anti-smuggling + value validation exactly as applyBootMenuEnv enforces;
 * other saved keys are preserved. Since 2d this routes through
 * saveBootDefaultsProfile — a single-row change IS a future-defaults change,
 * so it commits the next monotonic revision with its receipt instead of
 * dropping the profile fields back to the legacy shape (the runtime half of
 * the revision-rewind hole; the splash asset's writer carries the fields
 * forward at its rebake — the version-together set).
 */
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
  // Rebuild the saved map keyed by CANONICAL spelling (a saved file carries
  // the spelling pair per row; the profile writer re-pairs).
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

// ── versioned Boot future-default profiles ─────────────────
//  The SAME owner and the SAME file (`boot-env.json`) — no parallel settings
//  store. The legacy `{version, savedAt, env}` shape extends with a MONOTONIC
//  profile revision, a content digest, and the durable copy-correct save
//  receipt. Readers treat a pre-profile file (splash-era saves, older
//  runtimes) as revision 0 with a computed digest — nothing rewinds, nothing
//  breaks; the splash's own writer carries the fields forward at the 2c-ii
//  rebake (the version-together set).

export interface BootDefaultsProfileV1 {
  version: typeof BOOT_ENV_VERSION
  savedAt: string
  env: Record<string, string>
  /** Monotonic — 0 marks a pre-profile file; every save commits prev+1. */
  revision: number
  /** sha256 over the canonical env rows (sorted `key=value` lines). */
  digest: string
  /** The copy-correct receipt ("applies to sessions created after
   *  revision N · existing sessions unchanged"). */
  receipt: string
}

export function profileDigestOf(env: Record<string, string>): string {
  const canonical = Object.keys(env)
    .sort()
    .map(k => `${k}=${env[k]}`)
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** Validated profile read — a missing file answers null; a legacy file
 *  (no revision) answers revision 0 with its computed digest. */
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

/**
 * Atomically commit the NEXT future-defaults profile revision.
 * Every key must be a startup-menu row and every value one of its
 * declared choices (the registry law writeBootEnvChoice enforces per-key —
 * refused keys refuse the WHOLE save; a settings screen never half-commits).
 * The receipt states future-only application; established sessions never
 * observe this save (their immutable snapshots pin the OLD revision —
 * the contract, proven at the supervisor seam).
 */
export function saveBootDefaultsProfile(
  env: Record<string, string>,
  path: string = bootEnvPath(),
  opts?: {
    /** The receipt's "M existing sessions unchanged" count — the CALLER
     *  reads the bounded supervisor summary (this substrate owner never
     *  imports the daemon); absent ⇒ the countless copy (splash-era saves). */
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
 // Both spellings per row (the mixed-version window law).
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

// ── the immutable per-session effective-settings snapshot ─────────────

export interface EffectiveSettingRow {
  env: string
  /** The effective value — null when the row rides its default. */
  value: string | null
  /** Provenance: the EXPLICIT-ENV-ALWAYS-WINS law is visible per row. */
  source: 'process-env' | 'profile' | 'default'
  /** v1: every menu row applies at session creation (boot-applied env);
   *  per-row live/safe-boundary/restart classes deepen with the in-process
   *  Boot Settings surface. */
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

/**
 * Resolve ONE immutable effective-settings snapshot for a session at
 * admission: per menu row — the real environment wins (the :634 law,
 * recorded as provenance), else the saved profile, else the default. The
 * snapshot is a VALUE (the caller persists it where the session lives —
 * the Concourse worker record carries snapshotId + revision); resolving
 * again after a later profile save yields a DIFFERENT snapshot for NEW
 * sessions while established records keep what they captured.
 */
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

// ── the CONFIG-BACKED Coordinator row ────────────────────────
//  STARTUP_MENU rows are env-flag-backed by LAW (rows ⊆ FLAG_REGISTRY — the
//  anti-smuggling allowlist applyBootMenuEnv enforces over boot-env.json).
//  The Coordinator toggle's ONE truth home is the EXISTING config owner,
//  getGlobalConfig().concourseCoordinator.mode — not an env flag — so it
//  joins the boot menu as a config-backed row BESIDE the table: never baked
//  into the splash, never saved to or applied from boot-env.json, written
//  only through the safe-boundary switch owner (switchCoordinatorMode, with
//  its receipts and typed refusals). Operator vocabulary is EXACTLY on/off
//  (CA-02 — the words "Rules only"/"Agent-assisted" never paint). Mapping:
//
//    on  ⇒ mode 'agent-assisted'
//    off ⇒ mode 'rules-only' (the deterministic kernel's safety rails stay
//          armed); a pre-existing configured 'off' still READS as off — no
//          UI offers the bare 'off' enum value.

export interface ConfigMenuRow {
  /** Stable row identity for menu surfaces — NOT an env key. */
  id: string
  label: string
  group: string
  /** The closed choice vocabulary, in paint order (no leave-unset choice —
   *  the config owner always resolves a mode). */
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

/** The row's current choice, read from the ONE truth home. */
export async function readCoordinatorMenuChoice(): Promise<CoordinatorMenuChoice> {
  const { getGlobalConfig } = await import('../utils/config.js')
  return getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted' ? 'on' : 'off'
}

/** Write the row through the safe-boundary switch owner — its receipt
 *  (applied / no-change / refused + the boundary sentence) is the row's
 *  honest apply surface. Never boot-env.json. */
export async function writeCoordinatorMenuChoice(
  choice: CoordinatorMenuChoice,
): Promise<import('../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1> {
  const { switchCoordinatorMode } = await import('../services/concourse/coordinatorModels.js')
  return switchCoordinatorMode(choice === 'on' ? 'agent-assisted' : 'rules-only')
}

// ── explicit apply: the owning resolver's receipt surface ────

export type ExplicitApplyOutcome = 'applied' | 'queued' | 'refused' | 'no-change'

export interface ExplicitApplyReceipt {
  env: string
  outcome: ExplicitApplyOutcome
  /** The profile value the row WOULD move to (null = the default). */
  target: string | null
  reason: string
}

/**
 * Evaluate an EXPLICIT apply of the current future-defaults profile onto one
 * established session's captured snapshot: per row,
 * answer a target-specific receipt. Nothing here mutates the snapshot — the
 * evaluation IS the truth surface; a positive 'applied'/'queued' outcome only
 * exists for rows whose application class supports a live/safe-boundary
 * apply. v1 menu rows are ALL 'new-session' class (they resolve at session
 * creation via boot-applied env), so a changed row honestly REFUSES with the
 * class named — the vocabulary {applied, queued, refused, no-change} is the
 * contract, ready for the first live-appliable class. Env-pinned rows
 * (source 'process-env') refuse on the EXPLICIT-ENV-ALWAYS-WINS law.
 */
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
    // v1: every row's application class is 'new-session' (the snapshot rows
    // record it) — a truthful explicit apply refuses and names the boundary.
    return {
      env: row.env,
      outcome: 'refused',
      target,
      reason: `applies at session creation (application class: ${row.applicationClass}) — the session keeps its captured snapshot r${snapshot.profileRevision}; recreate or resume-fresh to receive the newer profile`,
    } satisfies ExplicitApplyReceipt
  })
}
