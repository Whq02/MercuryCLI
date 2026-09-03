/* ============================================================================
   (share-by-extraction).

   ONE compose owner for the canonical Boot identity — the helmet tone grid,
   the (>_) rule, the pixel MERCURY wordmark, the ready hint and the action
   card — consumed by BOTH hosts:

     · the standalone launcher splash (mercury-splash.mjs beside this file):
       the process-boundary DRIVER keeps env capability resolution,
       alt-screen/stdin/receipts/gradient, and flattens these styled lines
       to raw SGR bytes exactly as before the split;
     · the in-process Boot face (src/components/BootSplashScreen.tsx): the
       SurfaceRouter's 'boot-settings' registration renders the SAME compose
       output through the Ink run adapter (splashRuns.ts parses the styled
       runs; Ink's own colorize law owns in-process color degradation).

   PURITY LAW: this module performs NO I/O and reads NO process/tty/env
   state — capability arrives through createSplashCore({nocolor, truecolor}),
   and host data (card rows, hint segments, strip lines) is injected into
   composeLockup. Import is side-effect-free (pinned by
   scripts/visual-finish/prove-splash-core-parity.ts, with the two-host
   structural census).

   The baked blocks (HEADSTD/WORD grids · MENU · MODEL_NAMES · RAMP LAW)
   live HERE now; their bake owners (scripts/splash/extract-logo.py,
   bake-menu.mjs, bake-ramp.mjs) target this file. Deploy ships this file
   beside splash.mjs (scripts/splash/deploy.sh); build.ts bundles it into
   dist for the in-process face.
   ========================================================================== */

// ── palette (the reference's own = the brand palette; capability-free
//    data — the emitters that TURN these into bytes live in the factory) ────
const T256 = { cream: 230, red: 167, faint: 243, dim: 137, dimred: 95 }
const CREAM = [240, 232, 214] // #F0E8D6
const RED = [221, 68, 68] // #DD4444 TERRA
const VOID = [13, 24, 27] // the SELECTED appearance's ground — AA mixes sink toward it (dark by construction)
// THE SHARED GROUND (the flat-ground law): the selected appearance's deep
// ground — mercuryPalette NIGHT #0D181B for the dark identity, #000000 for
// True Black — is the ONE terminal ground from launcher through boot to the
// REPL. The launcher's OSC-11 write derives from THIS export and the
// runtime sets the same family ground at boot (src/utils/cockpit/oasisBg.ts
// via groundFamilyFor), so the pair can never drift. PAIR-LAW: the family
// table below must not drift from src/components/mercuryPalette.ts —
// prove-splash.py and prove-ramp-parity pin the equality. Nothing paints a
// field background over it: composed glyphs ride the ground, exactly the
// REPL's own model. A painted field and the OSC-11 ground are two channels
// that can drift: a vignette painting its edge #070D12
// while the runtime re-asserts the OSC-11 ground to NIGHT at handoff
// (enterOasisBg) is two of our own constants fighting (the operator's bottom
// band, forensics). One value, one channel, nothing painted —
// the drift is structurally impossible now.
export const GROUND = VOID
// ── THE GROUND FAMILIES (the two appearances' deep grounds) ────────────────
// The launcher estate follows the persisted appearance: VOID (=== GROUND
// === PLATE_TONE — one array, one reference) anchors every plate fill, park
// ink, and AA/residue mix, so re-anchoring it IN PLACE re-grounds the whole
// estate with zero per-site edits. adoptGroundFamily runs ONCE per process
// before the first paint (both hosts construct their core after it) —
// deterministic per run, and an un-adopted module is byte-identical dark.
export const GROUND_FAMILIES = {
  dark: [13, 24, 27], // mercuryPalette NIGHT #0D181B
  'true-black': [0, 0, 0], // mercuryPalette TRUE_BLACK_GROUND #000000
}
export function adoptGroundFamily(name) {
  const family = GROUND_FAMILIES[name] ?? GROUND_FAMILIES.dark
  VOID[0] = family[0]
  VOID[1] = family[1]
  VOID[2] = family[2]
}
const FAINT = '#71807B' // cool tertiary (tracks hermesTheme FAINT)
const IVORY = '#EDE8DD'

// ── the extracted grids ('.'=void, E=cream, R=red) ──────────────────────────
// HEADSTD-GRID-START (baked by scripts/splash/extract-logo.py — from the reference PNG)
const HEADSTD = [
  '.........EEEEEE......................................',
  '..........EEEEEEEEEE......EEEEEE.....................',
  '.............EEEEEEEEEE..EEEEEEEEE...................',
  '...........EEE..EEEEEEEE.E......EEE..................',
  '...........EEEEEEE..EEEEE.........EE.................',
  '............EEEEEEEEE..EE..........E.................',
  '............EEE...EEEE.EE..........RRRRRR............',
  '............EEEEEEE..E.EE.......rRRRRR...............',
  '..............EEEEEEE..E......RRRRr..EEEEE...........',
  '...............E..EEEE......RRRr...EEEE..............',
  '...............EEEEE.EE...rRRR....EEEE...............',
  '................EEEEEE..rRRr...EEE..EEE..............',
  '.......................RRR...eEe...eeEE..............',
  '..................EE.rRRr..EEE....ee..E..............',
  '....................EE..EEEE....EEe..Ee..............',
  '...................EE..EEEe....EEEeE.EE..............',
  '..................EE..EEe..eEe.EEEEEEEE..............',
  '.................EE...Ee......eEEEEEEEEe.............',
  '................EE..EEEe.eE.EEEEEEEEEEEEe............',
  '..................EEEEEE..eEEEEEEEEEEeee.............',
  '...................E..EEe...EEEEEEEEEE...............',
  '.....................EEE.....EEEEEEEee...............',
  '...................EEEEE......EEEEEEEe...............',
  '......................Ee..e....EEEEEE................',
  '.....................EE...eE....eEEEEe...............',
  '.....................EE....EE......EE................',
  '....................EE....EEEe.......................',
  '...........................EEE.......................',
  '............................eEE......................',
  '..............................Ee.....................',
  '.....................................................',
  '.....................................................',
]
// HEADSTD-GRID-END


// WORD-GRID-START (baked by scripts/splash/extract-logo.py — from the reference PNG;
// the Y is HAND-CORRECTED post-bake: the reference's Y extracted 4-wide and lopsided
// — join at cols 1-2, stem right of the arms' axis — so it re-authors here as the
// canonical 5-wide symmetric glyph. Re-baking must preserve this block. The bottom
// pixel row is 'd' (mid-red): the same posterized ink-weight language as the head.)
const WORD = [
  'RR.RR...RRRRR...RRRRR...RRRRR...R...R...RRRRR...R...R',
  'RRRRR...R.......R...R...R.......R...R...R...R...R...R',
  'R...R...RRRR....RRRR....R.......R...R...RRRR.....RRR.',
  'R...R...R.......R..R....R.......R...R...R..R......R..',
  'd...d...ddddd...d...d...ddddd...ddddd...d...d.....d..',
  '.....................................................',
]
// WORD-GRID-END

const MIDCREAM = [168, 152, 128] // #A89880 — warm dune mid-tone (never grey)
const DEEPRED = [123, 50, 50] // #7B3232 CLAW — posterized red shading
const MIDRED = [172, 59, 59] // mixc(DEEPRED, RED, 0.5) — wordmark baseline ink
const DUNE = [47, 75, 82] // #2F4B52 — panel border (hermesTheme DUNE, oasis slate)
const PX = { E: CREAM, e: MIDCREAM, R: RED, r: DEEPRED, d: MIDRED }

// status-spine triplets (hermesTheme TEAL/AMBER/CRIMSON — named, not new hues)
const TEALC = [63, 191, 160]
const AMBERC = [219, 161, 61]
const CRIMSONC = [232, 85, 106]

// MERCURY-MENU-START (baked by scripts/splash/bake-menu.mjs — from src/substrate/startupMenu.ts; do NOT hand-edit)
const MENU = [
  {"env":"MERCURY_WARDS","legacy":null,"label":"Content-rule wards","group":"trust combo","summary":"denies edits/commands that break the mechanical house rules (stray hex colors · emoji in TUI code · force-push to main) and teaches the fix","detail":{"controls":"Deterministic rules over pending tool calls: a violating edit or command is denied with a short teaching note (which rule, what to do instead). Project rules extend via .mercury/wards.json; rules cost nothing until violated. Pairs with the self-check gate + Debug tool — the trust combo.","on":["new hex outside the theme tokens, emoji in TUI sources, and force-pushes to main are denied at the moment of the call","denials name the rule and the compliant alternative"],"off":["no content rules — the gate-time ratchets remain the only backstop"]},"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_DAP","legacy":null,"label":"Debug tool (real debugger)","group":"trust combo","summary":"a real debugger the agent can drive — breakpoints, stepping, variables, evaluate — instead of print statements","detail":{"controls":"The Debug tool speaks the Debug Adapter Protocol to real debuggers (Python via debugpy, native code via lldb-dap). Launching a program under the debugger always asks permission first. Rounds out the trust combo: real runtime evidence instead of guesses.","on":["the Debug tool joins the catalog","launch asks permission like any command execution","inspection (stacks, variables) rides the permitted session"],"off":["the tool is absent — identical to a build without it"]},"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_THEMIS","legacy":null,"label":"Run discipline (THEMIS)","group":"trust combo","summary":"built-in attack-shape checks on risky commands, ON by default — enforce refuses with a typed message (never a prompt), warn records only, off disarms; tracked change missions (/mission) ride the same level","detail":{"controls":"Two things, truthfully: (1) a FIXED set of built-in attack-shape checks on risky shell/config commands (supply-chain installs, persistence, git-config mutation — house-style rules live in Wards) with a tamper-evident audit log; (2) tracked change MISSIONS for substantial work (/mission) — bounded criteria, expected paths, fresh verification evidence to complete. ON at enforce by default, measured imperceptible (sub-µs per call, ~0.1% of a real command round). A refused command is a typed teaching message — never a permission prompt; warn records without blocking when legitimate work trips a rule. No model calls, no spend.","on":["risky command shapes are checked before running (enforce refuses · warn records) — a typed refusal, never a prompt","a tamper-evident audit log accrues under the project's themis store","/mission tracks substantial changes; enforce refuses unexpected-path edits ONLY while a mission is active"],"off":["explicit off: no checks, no audit log, no /mission","repo generation (DAEDALUS) becomes unavailable — it requires this layer"]},"choices":[{"v":null,"l":"default (enforce)"},{"v":"warn","l":"warn"},{"v":"enforce","l":"enforce"},{"v":"off","l":"off"}]},
  {"env":"MERCURY_LSP_CPP","legacy":null,"label":"C/C++ IDE lane (clangd)","group":"trust combo","summary":"real C/C++ IDE evidence — diagnostics with clang-tidy, rename, source↔header — through a clangd the harness finds for you","detail":{"controls":"The C/C++ language lane of the IDE bridge: finds a clangd (PATH · Xcode · Homebrew llvm), lazy-starts it on the first C/C++ file touched, and answers through the LSP tool. Needs nothing from the project — a compile database sharpens it (evidence on /health). Pairs with the Debug tool: real IDE evidence instead of guesses.","on":["C/C++ files get diagnostics · rename · code actions · source↔header jumps","clang-tidy findings ride the diagnostics","no clangd installed ⇒ the lane simply stays quiet"],"off":["C/C++ files fall back to plain-text editing — no language server"]},"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_SKIP_PERMISSIONS","legacy":null,"label":"Skip permissions at boot","group":"trust combo","summary":"boot interactive sessions as if --dangerously-skip-permissions was passed — every tool call auto-approved","detail":{"controls":"The env spelling of --dangerously-skip-permissions: interactive boots start in sovereign mode without typing the flag. Saving this row is the standing consent; the launch confirmation dialog and the root/sudo refusal still apply. Headless runs (-p) and daemon workers NEVER inherit it — their stricter permission floor stands.","on":["interactive boots start with permissions bypassed (the crimson banner)","the launch consent dialog still confirms once","-p runs and daemon workers are unaffected"],"off":["permissions prompt normally; the CLI flag still works when passed by hand"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_AUTOPILOT","legacy":null,"label":"Autopilot tier mode","group":"trust combo","summary":"a bypass-family mode where the agent may retune its own model/effort under rails — shift+tab past bypass to enter","detail":{"controls":"Adds the Autopilot station to the shift+tab mode cycle (after Sovereign Mode): the same bypassed-permissions posture, plus the agent may retune its own model and reasoning effort mid-run via the SetTier tool — under mechanical rails (opus/sonnet only by default; 3-turn cooldown; 8 switches per session; every switch shown in the transcript and the mode band). Requires the same launch consent as Sovereign Mode (pair it with the skip-permissions row or the CLI flag).","on":["the mode cycle gains ⌖ Autopilot (only when bypass is available)","the agent may downshift for mechanical work and upshift for hard work — always visibly","opus, sonnet, fable and fable51 are the self-selectable tiers; MERCURY_AUTOPILOT_MODELS narrows them"],"off":["no autopilot station, no SetTier tool — the plain cycle"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_TABULA_MINERVA","legacy":null,"label":"Minerva note curator","group":"scale & spend","summary":"tidy the project notepad file (/note) once per boot with one pass of the Minerva model — the model you pin in /submodels (unset until you do); one billed call","detail":{"controls":"The notepad curator: once per boot, one pass of the Minerva model reorganizes your project notepad journal (/note, its notepad.md on disk) — priorities, ordering, and one-line refinements beside your original wording. The Minerva model is the one you pin in /submodels — any row of the /model catalogue, carriers included; until you pin one Minerva is unset and the pass is skipped with that hint, spending nothing. One billed API call per boot once pinned; your notes never leave the machine otherwise. Minerva's room (/tabula) is separate: it refines your saved prompts only when you ask, one call per ↵.","on":["one Minerva-model call per boot when the notepad changed","notes get prioritized, ordered, and polished — originals always kept","a rejected pass changes nothing (deterministic validation)"],"off":["the notepad stays manual — capture with /note, organize with /minerva <msg>","Minerva's room (/tabula) still answers each ↵ on demand"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_MNEME","legacy":null,"label":"Project facts & decisions (MNEME)","group":"memory & missions","summary":"long-term memory organized by topic — the agent saves and recalls notes across sessions","detail":{"controls":"Long-term facts and decisions organized as hand-inspectable topic documents beside the always-on notes and lessons. A just-recorded fact is findable immediately; corrections supersede (the old value stays as history, never as current truth); maintenance runs itself at boot and turn end. Inspect, search, correct and maintain it all from /memory. Needs auto-memory on (it is, unless you disabled it). No model calls, no spend — capture is explicit.","on":["the agent gains record/search/read/correct memory tools","facts consolidate into topic documents automatically (boot + turn-end upkeep)","/memory shows status, search, corrections and maintenance; /health has a Memory row"],"off":["nothing written, no memory tools added","the always-on notes + experience-card lessons keep working"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_DAEDALUS","legacy":null,"label":"Repo generation (DAEDALUS)","group":"memory & missions","summary":"build a whole repository with a team of agents working in parallel (real API cost; rides the THEMIS control plane, on by default)","detail":{"controls":"Builds a whole repository from a brief using a team of agents — planners, developers, reviewers — SCALED to the brief (a tiny CLI gets 1 architect, not 4). Every launch is preview-first: a deterministic preflight shows the size class, roster, models and expected agent/token band with ZERO agents dispatched; the fleet runs only after you accept. Runs cost real API usage, shown before you commit. Rides Run discipline (THEMIS), which is on by default — only an explicit THEMIS off makes this unavailable.","on":["a daedalus entry appears in /workflows","preview-first: preflight (size class · roster · spend band) before ANY agent; accept launches","runs on the THEMIS control plane (on unless you switched it off)","models come from your choice — explicit, or the saved rows below (always shown at launch)"],"off":["not offered in /workflows","no chance of accidental multi-agent spend"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_DAEDALUS_MODEL","legacy":null,"label":"Repo-gen planner model","group":"memory & missions","summary":"your standing model choice for the planning roles — set it to skip the per-run question","detail":{"controls":"Your standing model choice for repo generation's planning roles (architects, lead reviewer, QA). Injected mechanically at launch with its provenance named, validated against the current model catalogue, and shown in the launch consent — an explicit per-run choice always wins.","on":["planning roles use this model automatically (named as the saved choice in the launch consent)","shown at launch — pass a different model in the run's args to override"],"off":["the run asks for a model pick before launching"]},"choices":[{"v":null,"l":"default (ask per dispatch)"},{"v":"opus","l":"opus"},{"v":"sonnet","l":"sonnet"},{"v":"fable","l":"fable"},{"v":"fable51","l":"fable51"}]},
  {"env":"MERCURY_DAEDALUS_EXECUTOR_MODEL","legacy":null,"label":"Repo-gen builder model","group":"memory & missions","summary":"your standing model choice for the building roles — set it to skip the per-run question","detail":{"controls":"Your standing model choice for repo generation's building roles (developers, repair, integrator). Injected mechanically at launch with its provenance named, validated against the current model catalogue, and shown in the launch consent — an explicit per-run choice always wins.","on":["building roles use this model automatically (named as the saved choice in the launch consent)","shown at launch — pass a different model in the run's args to override"],"off":["the run asks for a model pick before launching"]},"choices":[{"v":null,"l":"default (ask per dispatch)"},{"v":"opus","l":"opus"},{"v":"sonnet","l":"sonnet"},{"v":"fable","l":"fable"},{"v":"fable51","l":"fable51"}]},
  {"env":"MERCURY_SESSION_SUBAGENTS","legacy":null,"label":"Sub-agents","group":"agents","summary":"whether a session may spawn sub-agents — off removes the Agent tool from its roster and closes every spawn road; the concourse itself keeps launching sessions","detail":{"controls":"The sub-agents switch of the sessions born after this choice. On (the default): the Agent tool is in the roster and the model delegates as it does today. Off: the Agent tool is absent from the roster — the model never sees it — and every road that would spawn a sub-agent from inside the session (the tool, a skill fork, a workflow's agent hooks, the fleet tools, the Crew view's spawn key) answers one receipt naming /subagents and this menu. Per session: the concourse coordinator's own launches are untouched. Inside a session, /subagents on|off (or this row, opened there) flips it at the next turn boundary — the tool leaves or rejoins the roster, reasoning restarts on the next turn, and a spawn already running finishes.","on":["the Agent tool is in the roster; skills, workflows and the fleet tools may spawn","a running session flips it any time with /subagents off"],"off":["no Agent tool in the roster; every spawn road answers \"sub-agents are off for this session\"","the concourse still launches sessions and crew seats","flip it back inside a session with /subagents on"]},"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_SESSION_WORKFLOWS","legacy":null,"label":"Workflows","group":"agents","summary":"whether a session may run workflows — off removes the Workflow tool from its roster and closes the workflow launch roads (the run board stays readable)","detail":{"controls":"The workflows switch of the sessions born after this choice. On (the default): the Workflow tool is in the roster and the workflow commands launch as they do today. Off: the Workflow tool leaves the roster and every workflow launch road (the tool, a workflow's own command) answers one receipt naming /workflows and this menu; /workflows still opens the run board to watch past runs. Inside a session, /workflows on|off (or this row, opened there) flips it at the next turn boundary — the tool leaves or rejoins the roster, reasoning restarts on the next turn, and a run already going finishes.","on":["the Workflow tool is in the roster; the workflow commands launch","a running session flips it any time with /workflows off"],"off":["no Workflow tool in the roster; the launch roads answer \"workflows are off for this session\"","the run board (/workflows) stays readable","flip it back inside a session with /workflows on"]},"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_LAUNCH_RIPPLE","legacy":null,"label":"Launch animation","group":"miscellaneous","summary":"the splash ripple on launch — turn off for the fastest boot handoff","detail":{"controls":"The circuit-trace ripple the splash plays while handing the session over. Off is the fast-boot lever: the splash paints once and hands over immediately. Reduced-motion (MERCURY_REDUCED_MOTION=1) also suppresses it; MERCURY_SPLASH=off skips the splash entirely.","on":["the authored launch ripple on truecolor terminals"],"off":["no animation — the fastest handoff to the session"]},"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_GODOT","legacy":null,"label":"Godot language lanes","group":"miscellaneous","summary":"GDScript IDE + debugger through your running Godot editor — outline, member search, navigation, breakpoints","detail":{"controls":"Arms both Godot lanes: the GDScript language server (outline · member search · navigation — it lives INSIDE the Godot editor, reached over a loopback bridge on :6005) and the godot debug adapter (:6006) for the Debug tool. Activates only in a project with a project.godot, and the editor must be open — a closed editor answers with a teaching note, never a hang. Pairs with the Godot control surface (VULCAN) below for full editor control.","on":[".gd files get the GDScript IDE ops through the LSP tool","the Debug tool gains the 'godot' adapter (breakpoints in the running editor)","no project.godot or no running editor ⇒ an honest teaching note"],"off":["no Godot servers are ever dialed — identical to a build without it"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_GODOT_TOOLS","legacy":null,"label":"Godot control surface (VULCAN)","group":"miscellaneous","summary":"full editor control for Godot projects — scenes, nodes, resources, play-testing, runtime inspection, input simulation (163 ops)","detail":{"controls":"The agent drives your running Godot editor directly: scene and node editing (every change is one Ctrl+Z undo step), scripts, resources, animation, physics, audio, tilemaps, shaders — plus play-testing with live game inspection and input simulation. Arming it also shifts agent behavior: sessions and spawned agents learn to prefer editor state over hand-editing scene files. Needs the bundled mercury_vulcan addon installed in the project (the tool installs it on ask) and the editor open. Local and sandboxed: a token-authed loopback connection only; running code or simulating input always asks permission first. Pairs with the Godot language lanes above (symbols + breakpoints stay with the LSP/Debug tools).","on":["the Godot tool joins the catalog in Godot projects (163 editor ops + extras)","reads are free; edits ask like file edits and are undoable in the editor; play/input/execute always ask","agents shift behavior: editor-first workflow, play-test natively, memory keeps project facts"],"off":["no Godot tool, no connection, no addon writes — identical to an unarmed build"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_UNITY","legacy":null,"label":"Unity dev lanes","group":"miscellaneous","summary":"C# IDE + attach-to-editor debugging + editor bridge (play/scenes/tests) + headless test/build profiles for Unity projects — nothing is ever installed or run for you without asking","detail":{"controls":"Arms the Unity lanes in a project with Assets/ + ProjectSettings/: the C# language server lane (your own csharp-ls or OmniSharp from PATH — never auto-installed; doctor teaches the install line when absent), the Debug tool's `unity` adapter (attaches to your RUNNING editor via the official Unity VS Code extension's adapter — the editor hosts the debuggee, so every gesture is an attach), the `Unity` tool driving your running editor over a token-authed loopback bridge (play mode, scenes, hierarchy, console, Test Runner — needs the bundled bridge package installed in the project, which the tool does on ask; play/test gestures always ask permission), and headless -batchmode test/build launch profiles the tool hands you to run yourself. Unity's own licensing applies to headless editor runs; if a run fails with Unity's licensing error, activating a license is yours to do (Unity Hub or -serial) — Mercury never checks or manages licenses, and never launches or installs the editor.","on":[".cs files in Unity projects get IDE ops through the LSP tool (csharp-ls/OmniSharp from PATH)","the Debug tool gains the 'unity' adapter — breakpoints in your running editor (port from Library/EditorInstance.json)","the `Unity` tool joins the catalog in Unity projects — play/scenes/hierarchy/console/test runs through your running editor (bridge package installed on ask; reads are free, everything else asks)","headless test/build profiles appear; running them stays your act (the exact command is printed, license disclaimer included)"],"off":["no Unity surface exists — identical to a build without it"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_BLENDER","legacy":null,"label":"Blender dev lanes","group":"miscellaneous","summary":".blend awareness + Blender bridge (scene/render/python) + headless render/python profiles + the debugpy attach recipe — Blender located (app bundle counts), never installed, launched, or enabled for you","detail":{"controls":"Arms the Blender lanes: .blend discovery (bounded), the app located your way — a PATH blender, /Applications/Blender.app (the normal Mac install), Program Files, or a MERCURY_BLENDER_BIN pin — with its version probed, headless --background render/python launch profiles the tool hands you to run yourself (arguments in documented order — output before frame), the debugpy attach recipe: one line starts a listener inside Blender, then the Debug tool attaches over the landed debugpy road (the bundled debugpy serves when this build carries it), and the `Blender` tool driving your running Blender over a token-authed loopback bridge (scene/objects truth, blend opens, still renders, report tail, python_run — needs the bundled add-on installed to the user addon home, which the tool does on ask, and ENABLED in Blender's Preferences, which stays your act; python_run and renders always ask permission). Mercury never installs, launches, or enables Blender or its add-ons.","on":["doctor gains the Blender lane row (path + version, or the honest install line)","headless render/python profiles appear; running them stays your act (the exact command is printed)","the debug recipe row teaches listen-then-attach (breakpoints in your addon/script files)","the `Blender` tool joins the catalog beside .blend files — scene/objects/render truth, blend opens, still renders, report tail, python_run through your running Blender (add-on installed on ask, enabled by you; reads are free, everything else asks)"],"off":["no Blender surface exists — identical to a build without it"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_ASEPRITE","legacy":null,"label":"Aseprite dev lanes","group":"miscellaneous","summary":"sprite awareness + the Aseprite batch door (sprite census, PNG/GIF/sprite-sheet exports, new sprites, Lua scripts) — Aseprite located (Steam and itch installs count), never installed or launched as a GUI for you","detail":{"controls":"Arms the Aseprite lanes: .aseprite/.ase discovery (bounded), the app located your way — a PATH aseprite, /Applications/Aseprite.app (the direct download), the Steam library, the win32 installer/itch homes, or a MERCURY_ASEPRITE_BIN pin (the road for source builds) — with its version probed, and the `Aseprite` tool driving the app's own batch mode: sprite census (layers, tags, frames, size), exports with the real CLI options (scaling, layer/tag selection, split files, sprite-sheet layouts with JSON metadata), new sprites, and Lua scripts. Every operation is a bounded background run of `aseprite -b` — the GUI is never started. Exports and new sprites ask permission naming the destination; running a script always asks (it is code). Mercury never installs or launches Aseprite for you.","on":["the `Aseprite` tool joins the catalog beside sprite files, or anywhere the app is located (creating from nothing works)","sprite census reads are free; exports and new sprites ask naming their files; Lua scripts always ask","no Aseprite on the box ⇒ honest teaching notes naming every install road"],"off":["no Aseprite surface exists — identical to a build without it"]},"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_CAP_FAILOVER","legacy":null,"label":"Cap failover posture","group":"miscellaneous","summary":"when the usage window of the family you run on caps out: the SLOT rung always asks first (a one-key switch to the same family's other signed-in slot with headroom; auto switches it unattended) · offer (default) adds the one-keypress cross-family handoff card to another signed-in family — nothing moves without your confirm · off waits for reset instead · auto hands off unattended and returns on the observed reset","detail":{"controls":"What happens when the usage window of the family the session runs on runs out mid-work — the same for every signed-in family, no favourite. TWO rungs. The SLOT rung (within the family — Anthropic's sign-in↔managed key, OpenAI's subscription↔API key): whenever the walled family's OTHER slot is signed in with headroom, the wall presents a one-key slot-switch card at EVERY posture — off included (the wall is never a dead end); at auto the slot switches unattended, receipted on the wall row and in the slot state. Nothing signs out; the next turn rides the other slot. The CROSS-FAMILY rung: offer (the default) — a usage warning or a reached window on the home family presents a one-keypress card (family · window · reset time · spend posture) that opens the model-transition preview; confirming hands the session to the readiest usable lane of the OTHER signed-in families — the most recent sign-in first — at a safe boundary; no usable second lane, no card. off — never leaves the family, never offers; work waits for the reset. auto: a reached window hands off unattended (daemon/overnight runs) — warnings still show the visible offer. Return is symmetric: once the home family's window is OBSERVED to reset (a fresh reply says so, or the provider's own stated reset moment passes) and its credential is still signed in, the same posture offers or executes the way home. Signing the home family out ends the handoff — there is no home to return to. A slot switch back is the same one key (or /router source) once the walled window resets.","on":["offer (the default): warnings and caps on the family you run on present the one-keypress handoff card to another signed-in family — nothing moves without your confirm, and no card appears without a usable second lane","auto: a walled slot switches to its family sibling unattended, and a capped family hands off cross-family at a safe boundary — receipted both ways","on the home window's observed reset, the same posture brings work home to the family it left"],"off":["the slot rung still ASKS — a walled slot with a signed-in sibling gets the one-key switch card (the wall is never a dead end)","cross-family: never switches, never offers — a capped family waits for its reset (the pre-change default, selectable exactly)"]},"choices":[{"v":null,"l":"default (offer)"},{"v":"off","l":"off"},{"v":"auto","l":"auto"}]},
  {"env":"MERCURY_CONCOURSE","legacy":null,"label":"Session Concourse at boot","group":"miscellaneous","summary":"where a plain boot LANDS — the Concourse itself stays on either way: Off lands the Boot face · Auto lands the Concourse board when sessions are live or waiting · Always makes the board the boot home","detail":{"controls":"Where a boot lands — never whether the Session Concourse exists (that is the persisted `--concourse-off` switch; the Concourse stays a first-class screen whatever this row says). Off (default): a plain `mercury` launch lands on the Boot face, with the Concourse one shift+← from the chat and a face row away; a prompt argument or `--continue`/`--resume` goes straight to the chat; existing background sessions are untouched. Auto: the boot lands on the Concourse board exactly when it has something to show (more than one live session, or a session waiting on you); otherwise the Boot face as usual. Always: the Concourse board is the boot home. Resolution reads one bounded records summary before the chat mounts — never a daemon call, never fleet discovery.","on":["auto: >1 live session or a waiting question boots into the Concourse board","always: every boot lands on the Concourse board (the chat one shift+→ away)","existing sessions are never cancelled, hidden or mutated by any choice"],"off":["plain launches land the Boot face; the Concourse stays on — shift+← from the chat (or its face row) opens the board"]},"choices":[{"v":null,"l":"default (off)"},{"v":"auto","l":"auto"},{"v":"always","l":"always"}]},
]
// MERCURY-MENU-END

// MERCURY-MODEL-NAMES-START (baked by scripts/splash/bake-menu.mjs — from src/utils/model owners; do NOT hand-edit)
const MODEL_NAMES = {
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
  "claude-sonnet-4-20250514": "Sonnet 4",
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-opus-4-20250514": "Opus 4",
  "claude-opus-4-1-20250805": "Opus 4.1",
  "claude-opus-4-5-20251101": "Opus 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5": "Opus 5",
  "claude-fable-5": "Fable 5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-mythos-5": "Mythos 5",
  "sonnet": "Sonnet 5",
  "opus": "Opus 5",
  "haiku": "Haiku 4.5",
  "fable": "Fable 5",
  "fable51": "Fable 5.1",
  "mythos": "Mythos 5",
  "best": "Opus 5",
  "opusplan": "Opus in strategy mode, else Sonnet",
}
// MERCURY-MODEL-NAMES-END

const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
// ── FOCAL RAMP — the
//    identity ramp the wordmark pixels and the selected launcher-row label
//    walk: accent → the BELLY bloom → the 0.7 ink-walk toward IVORY, sampled
//    PIECEWISE-LINEAR (the RF-1 canonical law — the floor-bucket painted the
//    word as three flat blocks, D2, and left the all-'d' baseline a fixed
//    dark stripe, D3). The word (fixed 53-col authored art) samples the
//    ENDPOINT coordinate u = x/(W-1), so the left edge is EXACTLY the accent
//    and its depth ink byte-equals the authored MIDRED (ruling R2:
//    deep(x) = mixc(DEEPRED, sample(x), 0.5) — depth inherits locality; CLAW
//    stays the one shadow anchor). The label keeps its COLUMN-SPACE
//    center-cell coordinate (ruling R3). Reduced colour (!TRUECOLOR)
//    collapses FLAT (the CN-08 law): fg256ish would bucket BELLY to grey;
//    NOCOLOR strips every SGR at the emitters.
// MERCURY-RAMP-LAW-START (baked by scripts/splash/bake-ramp.mjs — RAMP from
// deriveFocalRamp(TERRA, BELLY, IVORY) · RAMP_FIXTURE from focalRamp.ts
// rampSampleAt at the word's endpoint coordinate u=x/(W-1), W=53, deep =
// mixc(CLAW, face, 0.5) (the R2 law; [0] byte-equals the authored MIDRED) ·
// CAPABILITY_TRUTH from colorize.ts shouldHonorNoColor + the
// MERCURY_TRUECOLOR registry row. Do NOT hand-edit — rerun the bake;
// scripts/splash/prove-ramp-parity.ts + bake-ramp --check go red on drift.)
const RAMP = [[221,68,68],[229,132,132],[232,183,175]]
const RAMP_FIXTURE = [[0,221,68,68,172,59,59],[7,223,85,85,173,68,68],[15,226,105,105,175,78,78],[22,228,122,122,176,86,86],[26,229,132,132,176,91,91],[30,229,140,139,176,95,95],[37,230,154,150,177,102,100],[45,231,169,163,177,110,107],[52,232,183,175,178,117,113]] // [x, faceRGB..., deepRGB...]
const CAPABILITY_TRUTH = [[null,null,null,"xterm-256color","truecolor"],["1",null,null,"xterm-256color","plain"],["1","1",null,"xterm-256color","truecolor"],["",null,null,"xterm-256color","truecolor"],["1","",null,"xterm-256color","plain"],[null,null,"0","xterm-256color","256"],[null,null,null,"dumb","256"],[null,null,null,"linux","256"],["1",null,"0","xterm-256color","plain"]] // [NO_COLOR, FORCE_COLOR, MERCURY_TRUECOLOR, TERM, mode]
// MERCURY-RAMP-LAW-END
const rampSample = u => {
  const s = Math.min(1, Math.max(0, u)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(s))
  return mixc(RAMP[i], RAMP[i + 1], s - i)
}

// ── ACCENT FAMILIES ────
// The splash accent follows the SELECTED critter's theme family, resolved by
// the HOST (the launcher reads the persisted /critter default; the Boot face
// reads the live session accent) and injected via createSplashCore. Each
// family: main/deep = the critterData hue pair (crab = TERRA/CLAW), soft =
// the family bloom (crab keeps the authored BELLY; others deriveAccentSoft
// main→IVORY at 0.4), ramp = deriveFocalRamp(main, soft, IVORY), t256/
// t256deep = the 256-fallback pair (crab keeps its authored 167/95; others
// nearest xterm-cube). DEFAULT_CRITTER matches critterData's
// DEFAULT_CRITTER_KEY — a fresh operator's splash and their booted session
// wear the same creature by construction.
// MERCURY-ACCENT-FAMILIES-START (baked by scripts/splash/bake-ramp.mjs — from
// critterData.ts hues + the deriveAccentSoft/deriveFocalRamp laws; do NOT
// hand-edit — rerun the bake; prove-ramp-parity.ts §7 goes red on drift.)
const ACCENT_FAMILIES = {
  crab: { main: [221,68,68], deep: [123,50,50], soft: [229,132,132], ramp: [[221,68,68],[229,132,132],[232,183,175]], t256: 167, t256deep: 95 },
  octopus: { main: [176,123,224], deep: [110,75,160], soft: [200,167,223], ramp: [[176,123,224],[200,167,223],[219,199,222]], t256: 140, t256deep: 61 },
  jellyfish: { main: [111,199,232], deep: [63,126,150], soft: [161,212,228], ramp: [[111,199,232],[161,212,228],[199,222,224]], t256: 80, t256deep: 66 },
  clam: { main: [22,216,176], deep: [14,147,119], soft: [108,222,194], ramp: [[22,216,176],[108,222,194],[173,227,208]], t256: 43, t256deep: 30 },
}
const DEFAULT_CRITTER = "jellyfish"
// MERCURY-ACCENT-FAMILIES-END

// Retired spellings with a successor resolve to it ('mantis' / 'mantis
// shrimp' → 'clam' — the clam took the mantis shrimp's slot and family),
// unknown keys to the default — the same read-side resolution
// sessionAccent.ts poolKeyOr / critterData LEGACY_CRITTER_KEYS apply, so the
// splash and the booted session can never disagree about which creature a
// stale key became. The stored config value is never rewritten.
export function accentFamilyKeyOf(raw) {
  const k = String(raw ?? '').trim().toLowerCase()
  if (Object.hasOwn(ACCENT_FAMILIES, k)) return k
  if (k === 'mantis' || k === 'mantis shrimp') return 'clam'
  return DEFAULT_CRITTER
}

// ── the GREETING SHIMMER law ─────────────────────────────
// Hand-mirror of src/utils/cockpit/greetingShimmer.ts (the splash imports
// nothing from src) — prove-ramp-parity.ts §7 pins the mirror against the
// canonical schedule value-for-value. The shimmer is a GREETING, never a
// loop: the ramp's bright band ping-pongs left→right→left for ~10 s from a
// surface's first open (or a row's fresh selection), eases out, and settles
// into the exact static gradient; phaseAt returns null once settled (and
// during the zero-gain ease-in instants), and null renders the settled
// bytes by construction (boost 0 ⇒ the same sample).
// SPLASH-GLOW-START (mirror-proven by scripts/splash/prove-ramp-parity.ts §7)
const GLOW = {
  TICK_MS: 80,
  GREETING_MS: 10_000,
  EASE_IN_MS: 350,
  EASE_OUT_MS: 1500,
  LEG_MS_PER_CELL: 55,
  LEG_MIN_MS: 1300,
  LEG_MAX_MS: 3200,
  LIFT: 0.85,
  GAIN_LEVELS: 5,
}
const glowRadius = span => Math.max(3, Math.min(8, Math.round(span * 0.28)))
const glowLegMs = span =>
  Math.max(GLOW.LEG_MIN_MS, Math.min(GLOW.LEG_MAX_MS, span * GLOW.LEG_MS_PER_CELL))
const glowEnvelope = t => {
  if (t <= 0 || t >= GLOW.GREETING_MS) return 0
  const outStart = GLOW.GREETING_MS - GLOW.EASE_OUT_MS
  if (t < GLOW.EASE_IN_MS) { const x = t / GLOW.EASE_IN_MS; return x * x }
  if (t > outStart) { const x = (GLOW.GREETING_MS - t) / GLOW.EASE_OUT_MS; return x * x }
  return 1
}
const glowPeakAt = (t, span) => {
  if (span <= 1) return 0
  const leg = glowLegMs(span)
  const tau = (t % (2 * leg)) / (2 * leg)
  return ((1 - Math.cos(tau * 2 * Math.PI)) / 2) * (span - 1)
}
/** The quantized phase at an elapsed time, or null (settled / zero gain). */
export function glowPhaseAt(elapsedMs, spanCells) {
  if (elapsedMs >= GLOW.GREETING_MS) return null
  const gainLevel = Math.round(glowEnvelope(elapsedMs) * GLOW.GAIN_LEVELS)
  if (gainLevel <= 0) return null
  return {
    peakCell: Math.round(glowPeakAt(elapsedMs, spanCells)),
    gainLevel,
    radiusCells: glowRadius(spanCells),
  }
}
/** Per-cell boost fraction (0 outside the band — settled bytes there). */
export function glowBoostAt(cellCenter, phase) {
  if (!phase) return 0
  const d = Math.abs(cellCenter - phase.peakCell)
  if (d >= phase.radiusCells) return 0
  const w = Math.cos((d / phase.radiusCells) * (Math.PI / 2))
  return GLOW.LIFT * (phase.gainLevel / GLOW.GAIN_LEVELS) * w * w
}
/** True once a greeting armed at elapsed 0 has settled for good. */
export const glowSettled = elapsedMs => elapsedMs >= GLOW.GREETING_MS
export const GLOW_TICK_MS = GLOW.TICK_MS
// SPLASH-GLOW-END

// The glow SPAN facts hosts arm phases with (glowPhaseAt(elapsed, span)):
// the authored word grid's column count and the card's fixed label column.
export const WORD_W = Math.max(...WORD.map(r => r.length))
export const CARD_LABEL_W = 23

// visible length (strip SGR, then count DISPLAY COLUMNS).
// `.length` counted UTF-16 code units: an East Asian wide char (2 columns)
// counted 1, an astral char (1-2 columns) counted 2, a combining mark
// (0 columns) counted 1 — operator-controlled strings (directory names, the
// account email) broke every box border by the difference. ~30 lines, no
// dependency: the East Asian Wide/Fullwidth blocks real filesystem paths hit,
// combining marks via \p{M}, surrogates paired by code-point iteration.
// SPLASH-VIS-START (unit-proven by scripts/splash/prove-splash-units.ts)
const SGR_RE = /\x1b\[[0-9;]*m/g
const cpWidth = cp => {
  if (cp === 0x200d) return 0 // zero-width joiner
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo (leading)
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // pictographs + emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B+
  ) return 2
  return 1
}
const MARK_RE = /\p{M}/u
const NON_SIMPLE_RE = /[\u0300-\u{10ffff}]/u
const vis = s => {
  const t = s.replace(SGR_RE, '')
  if (!NON_SIMPLE_RE.test(t)) return t.length // ASCII/latin fast path
  let w = 0
  for (const ch of t) {
    if (MARK_RE.test(ch)) continue
    w += cpWidth(ch.codePointAt(0))
  }
  return w
}
// SPLASH-VIS-END

// ── box-drawing helpers (SGR-aware padding via vis()) ────────────────────────
const padVis = (s, w) => s + ' '.repeat(Math.max(0, w - vis(s)))

// Greedy word-wrap to a display width (plain text — color added by callers).
function wrapWords(txt, w) {
  const words = String(txt).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const wd of words) {
    if (cur && (cur + ' ' + wd).length > w) {
      lines.push(cur)
      cur = wd
    } else cur = cur ? cur + ' ' + wd : wd
  }
  if (cur) lines.push(cur)
  return lines
}

// Zip two line columns side by side (SGR-aware left padding).
function zipCols(a, b, aW, gap) {
  const n = Math.max(a.length, b.length)
  const outL = []
  for (let i = 0; i < n; i++) {
    outL.push(padVis(a[i] ?? '', aW) + ' '.repeat(gap) + (b[i] ?? ''))
  }
  return outL
}

// ── the ONE action-card data assembly (not one menu — the
//    ORIGINAL menu, both hosts). Card-row COMPOSITION was already core
//    (composeCard); this is the row DATA assembly — labels, ctx grammar and
//    the presence laws — parameterized by host facts so neither host ever
//    re-copies a row. The launcher gathers facts from its pre-boot scans;
//    the in-process Boot face gathers the same facts from its live owners.
//    ctx is the HOST-TRUTH channel (the concourse fact differs by design);
//    rows, labels, icons and presence laws are invariant. ─────────────────────
export function fmtAge(ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function assembleCardRows(facts) {
  const rows = []
  // "New Session in <folder>" — FIRST + default-focused (#179): launching in
  // a folder defaults to starting fresh HERE. The clamp is the Dir chip's
  // exact grammar (24 → 23+ellipsis).
  const cwdBase = facts.cwdBase
  rows.push({
    key: 'new',
    icon: '✶',
    label: `New Session in ${cwdBase.length > 24 ? cwdBase.slice(0, 23) + '…' : cwdBase}`,
    ctx: 'start fresh here',
  })
  // K2: the launched cwd WINS — Continue is cwd-scoped whenever THIS repo has
  // history; a history-less cwd names the crossing ("in <repo>") instead of
  // silently moving there. Self-omits when no session history anywhere.
  if (facts.continueTarget) {
    const ct = facts.continueTarget
    rows.push({
      key: 'continue',
      icon: '↗',
      label: 'Continue Last Session',
      // The cross-repo row is dim BY DESIGN (resume never crosses repos);
      // its ctx must carry the refusal AND the road, not read like an
      // ordinary target ('in myrepo · 2h ago' said neither).
      ctx: ct.cross ? `in ${ct.base} — via Sessions · Projects` : `${ct.base} · ${fmtAge(ct.ageMs)}`,
      ...(ct.dim ? { dim: true } : {}),
    })
  }
  if (facts.menuAvailable) {
    rows.push({ key: 'menu', icon: '⊞', label: 'Boot Menu', ctx: 'configure boot env' })
    // THE KIT DOOR: ONE added row,
    // directly after the Boot Menu (the two settings doors adjacent), on
    // EVERY boot face in EVERY world — the identical-worlds law (L24(6-
    // SUPERSEDED)): `--chat` differs from the full boot in exactly one thing
    // (no concourse row), so this row carries NO world check, and both
    // hosts compose it from the same fit fact the menu row rides (a face
    // too small for the menu is too small for the manager). The row OPENS
    // the MCPs & Skills manager (never inlays it): the runtime face hosts
    // the screen; the launcher writes the `kit` receipt action.
    // THE ARMED WEAR IS VISIBLE (lane KIT-PRESETS, the lead's ruling): while
    // a one-shot preset is armed the row's ctx says so — a wear is never a
    // surprise. Runtime-only truth (the launcher process can never hold an
    // armed wear); absent ⇒ the standing ctx, byte-identical across hosts.
    rows.push({ key: 'kit', icon: '⊛', label: 'MCPs & Skills', ctx: facts.kitArmedPreset ? `next: preset '${facts.kitArmedPreset}'` : 'what the next session loads' })
    // THE AGENTS DOOR (the operator's own proposal:
    // "fits right under the MCPs and Skills and over Saturn in the boot
    // menu with the same UI"; row position ruled UNDER-KIT,
    // operator-vetoable): one row directly after MCPs & Skills — the two
    // next-session-estate doors adjacent — riding the SAME fit fact as the
    // menu/kit doors (the agents screen composes through the boot-menu
    // design, so the menu floor is its floor), NO world check (the
    // identical-worlds law). ctx is HOST TRUTH (the concourse row's
    // channel): the runtime face passes the roster glance (facts.agentsCtx
    // — '<n> agents'); the launcher wears the standing words. The runtime
    // OPENS the layer; the launcher hands over with the `agents` receipt
    // action (an older runtime reads 'unknown-action' and boots plain —
    // the protocol's law).
    rows.push({ key: 'agents', icon: '◈', label: 'Agents', ctx: facts.agentsCtx ?? 'create and edit agents' })
  }
  rows.push({ key: 'doctor', icon: '✓', label: 'Doctor / Health Check', ctx: 'system diagnostics' })
  // THE SATURN DOOR: one row after Doctor —
  // the control-plane glance pair (the health board, then the schedules
  // board) — riding the SAME fit fact as the menu/kit doors (the scheduler
  // screen composes through the boot-menu design, so the menu floor is its
  // floor). ctx is HOST TRUTH (the concourse row's channel): the runtime
  // face passes the wake-glance words (facts.saturnCtx); the launcher
  // passes nothing and wears the standing words, byte-identical across
  // hosts when no live truth exists. The runtime face OPENS the screen;
  // the launcher hands over with the `saturn` receipt action (an older
  // runtime reads 'unknown-action' and boots plain — the protocol's law).
  if (facts.menuAvailable) rows.push({ key: 'saturn', icon: '◷', label: 'Saturn Scheduler', ctx: facts.saturnCtx ?? 'sessions born on the clock' })
  // THE LOGINS DOOR (the operator's own seat:
  // "it should live in the boot menu with its own container"): one row
  // after Doctor and Saturn — the control-plane glance RUN (the health
  // board · the schedules board · the credentials board) — riding the SAME
  // fit fact as the menu/kit/saturn doors (the sign-in layer composes
  // through the boot-menu design, so the menu floor is its floor). ctx is
  // HOST TRUTH (the concourse row's channel): the runtime face passes the
  // sign-in glance (facts.loginsCtx — '<n> of <total> signed in' from the
  // ONE presence owner); the launcher wears the standing words. The
  // runtime OPENS the layer; the launcher hands over with the `logins`
  // receipt action (an older runtime reads 'unknown-action' and boots
  // plain — the protocol's law).
  if (facts.menuAvailable)
    rows.push({ key: 'logins', icon: '⚿', label: 'Logins', ctx: facts.loginsCtx ?? 'sign in to providers' })
  //the concourse row's ctx is host truth — the
  // launcher's exactly-once receipt action vs the live in-process board.
  // A `--chat` boot (L15) carries NO concourse row — New Session is the
  // door — and both hosts pass null for it, so the launcher's frame 0 and
  // the in-process face compose the same six rows across the seam.
  if (facts.concourse) {
    rows.push({
      key: 'concourse',
      icon: '⊞',
      label: 'Session Concourse',
      ctx: facts.concourse.ctx,
      ...(facts.concourse.dim ? { dim: true } : {}),
    })
  }
  // THE MERGED DOOR (the operator's merge: "the projects in
  // the menu and the resume session — they could share a screen … two
  // separate containers on top of each other"): the standalone Projects
  // row(s) and the Resume row FOLD into ONE — 'Sessions · Projects' opens
  // the merged screen (sessions over projects, one highlight; Continue
  // Last Session stays its own one-keystroke row above). Always offered,
  // LAST (the resume slot's proof-leg stability). ctx is HOST TRUTH: the
  // runtime passes the live glance (facts.sessionsCtx); the launcher wears
  // the standing words and hands over with the `resume` receipt action —
  // the WIRE WORD IS UNCHANGED BY DESIGN (an older runtime reading
  // 'resume' opens its own resume screen honestly; a stale deployed
  // splash's `project` action stays CONSUMED runtime-side — the
  // degradation law both directions).
  rows.push({ key: 'sessions', icon: '↺', ctx: facts.sessionsCtx ?? 'pick a session or a repo', label: 'Sessions · Projects' })
  return rows
}

// ── PO-7: the ONE placement law ────────────────────────────────────────
// Natural block height + bounded optical distribution of the remaining rows:
// the lockup sits a touch above geometric centre (0.42 of the slack above,
// the rest below) on ordinary/tall terminals; when the block fills or
// overflows the rows, the compose tiers have already reprioritised and the
// block stays top-aligned (compact tightens before anything clips). The
// same owner places the splash lockup, the menu, and the projects view, and
// hands the placed centre to the gradient (rowTone) so the focus follows
// the content instead of a hard-coded fraction.
function placeBlock(block, rows) {
  const pad = rows - block.length
  if (pad <= 0) return { placed: block, top: 0 }
  const top = Math.max(0, Math.round(pad * 0.42))
  return { placed: [...Array(top).fill(''), ...block], top }
}

// ── the capability-bound core ───────────────────────────────────────────────
// The HOST owns capability truth: the standalone driver derives
// nocolor/truecolor from its env law (NO_COLOR/FORCE_COLOR/TERM/
// MERCURY_TRUECOLOR — the baked CAPABILITY_TRUTH above); the in-process
// face pins {nocolor:false, truecolor:true} and lets Ink's colorize law
// own degradation (CB-06: one compose owner, two byte-emitters).
// `accent`: the critter family key (or a resolved family
// object) whose hues own every accent surface — text highlight, wordmark
// gradient, selection chrome, the art's accent pixels. The HOST resolves
// which critter (persisted /critter default, env pin, live session accent)
// and passes it here; absent ⇒ the crab family, byte-identical to the
// pre-GLOW composition.
export function createSplashCore({ nocolor = false, truecolor = true, accent } = {}) {
  const NOCOLOR = !!nocolor
  const TRUECOLOR = !NOCOLOR && !!truecolor
  const ACC =
    accent && typeof accent === 'object'
      ? accent
      : ACCENT_FAMILIES[accentFamilyKeyOf(accent ?? 'crab')] ?? ACCENT_FAMILIES.crab
  const ACC_MID = mixc(ACC.deep, ACC.main, 0.5)
  const ACC_HEX = '#' + ACC.main.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()

// The PLAIN path (NOCOLOR): every styling emitter — reset, truecolor,
// 256-fallback, bold/dim — returns '' so the frame carries ZERO SGR bytes
// while layout stays byte-identical; screen management (alt-screen, cursor,
// clear) is not styling and stays. prove-splash.py pins the zero-SGR law.
const R = NOCOLOR ? '' : '\x1b[0m'
const BOLD = NOCOLOR ? '' : '\x1b[1m'
const BOLD_UL = NOCOLOR ? '' : '\x1b[1;4m'
const DIM = NOCOLOR ? '' : '\x1b[2m'

const rgbFg = ([r, g, b]) => (NOCOLOR ? '' : `\x1b[38;2;${r};${g};${b}m`)
const rgbBg = ([r, g, b]) => (NOCOLOR ? '' : `\x1b[48;2;${r};${g};${b}m`)
function hexFg(hex, fb) {
  if (NOCOLOR) return ''
  if (!TRUECOLOR) return `\x1b[38;5;${fb}m`
  return rgbFg([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)])
}
// nearest-256 for AA tones when truecolor is off: the ACCENT family's own
// pixels map to its baked 256 pair first (a cyan/violet family must not
// grey out under the red-tuned tone buckets), then bucket by tone. Crab is
// byte-identical: its baked pair IS.red/.dimred and its mid tone
// falls to the same red the bucket always chose.
function fg256ish(px) {
  if (NOCOLOR) return ''
  const [r, g, b] = px
  const is = a => a[0] === r && a[1] === g && a[2] === b
  if (is(ACC.main) || is(ACC_MID)) return `\x1b[38;5;${ACC.t256}m`
  if (is(ACC.deep)) return `\x1b[38;5;${ACC.t256deep}m`
  if (r > 180 && g > 160) return `\x1b[38;5;${T256.cream}m`
  if (r > 140 && g < 90) return `\x1b[38;5;${T256.red}m`
  if (r > 90 && g < 60) return `\x1b[38;5;${T256.dimred}m`
  return `\x1b[38;5;${T256.dim}m`
}

// ── renderers ────────────────────────────────────────────────────────────────
function paint(px) { return TRUECOLOR ? rgbFg(px) : fg256ish(px) }
function paintBg(px) { return TRUECOLOR ? rgbBg(px) : '' }

// The ART pixel table at the LIVE accent family: the
// authored grids' R/r/d ink slots are the brand's accent pixels — they
// follow the family exactly like the app's identity art (<Crab/> re-tints
// with the accent). Cream stays cream — the quiet base is untouched. Crab
// resolves byte-identical to the authored PX table.
const PXA = { E: CREAM, e: MIDCREAM, R: ACC.main, r: ACC.deep, d: ACC_MID }

// Hard half-block: 1 grid px = 1 half-cell (2 grid rows per terminal row).
function rasterHard(grid, toneAt) {
  const H = grid.length
  const W = Math.max(...grid.map(r => r.length))
  const g = grid.map(r => r.padEnd(W, '.'))
  // Optional per-pixel tone mapper (the CN-09 focal ramp rides it for the
  // wordmark only) — colour-only by construction: cells and runs unchanged.
  const px = (ch, x) => (toneAt ? toneAt(ch, x, W) : PXA[ch])
  const lines = []
  for (let y = 0; y < H; y += 2) {
    let line = ''
    let run = null
    for (let x = 0; x < W; x++) {
      const t = g[y][x]
      const b = y + 1 < H ? g[y + 1][x] : '.'
      let sgr, cell
      if (t === '.' && b === '.') { sgr = ''; cell = ' ' }
      else if (t !== '.' && b === '.') { sgr = paint(px(t, x)); cell = '▀' }
      else if (t === '.' && b !== '.') { sgr = paint(px(b, x)); cell = '▄' }
      else if (t === b) { sgr = paint(px(t, x)); cell = '█' }
      else { sgr = paint(px(t, x)) + paintBg(px(b, x)); cell = '▀' }
      if (sgr !== run) { line += R + sgr; run = sgr }
      line += cell
    }
    lines.push(line + R)
  }
  return { lines, width: W }
}

// ── the thin rule with the (>_) sigil (matches the reference's sub-grid
//    divider weight; ■ endpoints, triple dots flanking the sigil) ────────────
// The ONE accent chrome emitter: every cell that used to
// hard-pin `accentFg()` — carets, arrows, the (>_) sigil and
// rule, panel titles, hint keys — speaks the live family instead. Crab emits
// the identical bytes.
const accentFg = () => hexFg(ACC_HEX, ACC.t256)

function dividerLine(width) {
  const sigil = '(>_)'
  const dots = '···'
  const fixed = 2 + 2 + dots.length + 1 + sigil.length + 1 + dots.length + 2 + 2
  const seg = Math.max(2, Math.floor((width - fixed) / 2))
  const line = '─'.repeat(seg)
  return accentFg() + `■ ${line}${dots} ${sigil} ${dots}${line} ■` + R
}

// The LIVE face sampler: the piecewise-lerp law over the family's own ramp
// (crab's ramp IS the baked RAMP, so the crab face byte-equals rampSample).
const sampleFace = u => {
  const s = Math.min(1, Math.max(0, u)) * (ACC.ramp.length - 1)
  const i = Math.min(ACC.ramp.length - 2, Math.floor(s))
  return mixc(ACC.ramp[i], ACC.ramp[i + 1], s - i)
}

// Word pixels walk the family ramp at the endpoint coordinate; a greeting
// phase boosts in-band columns toward the ink stop (u' = u + boost·(1−u) —
// the same law rampSegments applies in the kit), and the depth ink inherits
// the boosted face (R2 locality: deep(x) = mixc(deep, face(x), 0.5)).
const wordTone = (ch, x, W, phase = null) => {
  if (!TRUECOLOR || (ch !== 'R' && ch !== 'd')) return PXA[ch]
  let u = x / (W - 1)
  const boost = glowBoostAt(x, phase)
  if (boost > 0) u = u + boost * (1 - u)
  const face = sampleFace(u)
  return ch === 'R' ? face : mixc(ACC.deep, face, 0.5)
}
const wordToneGlow = phase => (ch, x, W) => wordTone(ch, x, W, phase)
function rampLabel(text, phase = null) {
  if (!TRUECOLOR) return hexFg(IVORY, T256.cream) + text
  let out = ''
  let run = null
  for (let i = 0; i < text.length; i++) {
    let u = (i + 0.5) / text.length
    const boost = glowBoostAt(i + 0.5, phase)
    if (boost > 0) u = u + boost * (1 - u)
    const sgr = rgbFg(sampleFace(u))
    if (sgr !== run) { out += sgr; run = sgr }
    out += text[i]
  }
  return out
}

// round-5 chrome-plate law:
// boxed chrome sits on ONE flat plate — border and interior cells alike —
// so a border line cannot band, notch or cut against its surroundings under
// any terminal's colour handling. Interior resets re-assert the plate; an
// explicit content bg (rasterHard art cells) still wins until its own
// reset; the Boot face's parseSplashRuns keeps a run's own bg. Under
// NOCOLOR/256 the plate is '' and the bytes stay exactly the pre-plate
// shape. ROUND 8 (operator, real-terminal: "the menu itself has
// a weird colour — its background is a diff colour still"): the plate TONE
// is the GROUND itself. On the flat estate ground the lifted glass tone was
// the one surviving non-NIGHT surface and read as a mismatch; panels are
// now borders on the one ground — the REPL panel model exactly. The onPlate
// mechanism stays (explicit paint keeps boxed rows self-contained and
// border-safe against any future surroundings; Terminal.app renders the
// explicit SGR and the OSC-11 ground exact-sRGB-identical), only the tone
// collapsed into GROUND.
const PLATE_TONE = VOID // == GROUND — panels ride the one flat ground
const onPlate = s => {
  const p = paintBg(PLATE_TONE)
  return p ? p + s.replaceAll(R, R + p) + R : s + R
}
const boxTop = (w, bc) => onPlate(bc + '╭' + '─'.repeat(w) + '╮')
const boxBot = (w, bc) => onPlate(bc + '╰' + '─'.repeat(w) + '╯')
const boxSep = (w, bc) => onPlate(bc + '├' + '─'.repeat(w) + '┤')
const boxRow = (content, w, bc) => onPlate(bc + '│' + R + padVis(content, w) + bc + '│')

// SPLASH-CLIP-START (unit-proven by scripts/splash/prove-splash-units.ts)
function clipVis(s, w) {
  if (vis(s) <= w) return s
  // Column-accurate clip: advance by CODE POINT and count
  // DISPLAY columns via the same width engine as vis() — the old per-UTF-16-
  // unit `n++` re-broke the border for exactly the strings vis() now measures
  // (a CJK/emoji directory name in the picker rows).
  let acc = ''
  let n = 0
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i))
      if (m) {
        acc += m[0]
        i += m[0].length
        continue
      }
    }
    const cp = s.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const cw = MARK_RE.test(ch) ? 0 : cpWidth(cp)
    if (n + cw > w - 1) break
    acc += ch
    n += cw
    i += ch.length
  }
  return acc + '…' + R
}
// SPLASH-CLIP-END

// ── the ready-line hint (mockup-ratified grammar, host-injected keys) ──────
// `>_ ready · <key segments> · ↑↓ choose` — the KEY/LABEL segments are
// host-injected (CB-06: the two hosts' action sets diverge): the standalone
// advertises `↵ start` (+ `m menu` when the boot menu fits), the
// in-process face its own keys. `↑↓ choose` appears exactly when the card
// is on screen. Byte-law preserved from the pre-split hintFor.
function composeHint(segments, withCard) {
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const faint = hexFg(FAINT, T256.faint)
  let s = red + '>_ ' + R + ivory + 'ready' + R
  for (const seg of segments) {
    s += faint + '  ·  ' + R + red + seg.key + R + (seg.tone === 'ivory' ? ivory : faint) + seg.label + R
  }
  if (withCard) s += faint + '  ·  ' + R + red + '↑↓' + R + faint + ' choose' + R
  return s
}

function composeCard(rows, selIdx, w, seps = true, glowRow = null) {
  if (rows.length === 0) return { lines: [], rowLines: [] }
  const bc = paint(DUNE)
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const inner = w - 2
  const labelW = CARD_LABEL_W
  const lines = [boxTop(inner, bc)]
  const rowLines = []
  rows.forEach((r2, i) => {
    const sel = i === selIdx
    // The focused row wears a TEAL left edge-bar
    // + the accent caret; unfocused rows keep the quiet two-space gutter.
    const bar = sel ? paint(TEALC) + '▎' + R : ' '
    const caret = sel ? red + '❯ ' + R : '  '
    const icon = (sel ? red : faint) + r2.icon + R
    // The selected label walks the focal ramp across its fixed column
    // (CN-09); a fresh selection's greeting phase sweeps it (GLOW —
    // glowRow arrives from the host, null once settled). Unfocused rows
    // keep the quiet mid-cream. Colour-only: the padEnd geometry is
    // identical on both arms.
    const label = (sel ? BOLD + rampLabel(r2.label.padEnd(labelW), glowRow) : (r2.dim ? hexFg(FAINT, T256.faint) : paint(MIDCREAM)) + r2.label.padEnd(labelW)) + R
    const left = bar + caret + icon + ' ' + label
    // An unavailable row paints NO activation affordance — navigation
    // skips it, so a '→' there advertised a gesture that cannot fire; the
    // one-space stand-in keeps the box geometry byte-stable.
    const arrow = r2.dim ? ' ' : (sel ? red : faint) + '→' + R
    // C15 (BFF-01): the ctx column measures DISPLAY cells, never
    // UTF-16 units — .length under-counted a wide-glyph ctx (a CJK project
    // name in the continue row) so the gap over-granted and the row ran
    // through the card border; the clip is the core's own column-accurate
    // clipVis. A left side that already fills the row leaves the ctx a bare
    // ellipsis rather than widening the box.
    const ctxBudget = inner - vis(left) - 4
    let ctx = r2.ctx
    if (vis(ctx) > ctxBudget) ctx = ctxBudget > 1 ? clipVis(ctx, ctxBudget) : '…'
    const gap = Math.max(0, inner - vis(left) - vis(ctx) - 3)
    rowLines.push(lines.length)
    lines.push(boxRow(left + ' '.repeat(gap) + faint + ctx + R + ' ' + arrow + ' ', inner, bc))
    if (seps && i < rows.length - 1) lines.push(boxSep(inner, bc))
  })
  lines.push(boxBot(inner, bc))
  return { lines, rowLines }
}

// ── the STATUS STRIP (canon grammar, host-injected chip data) ──────────────
// DUNE box, two content rows, '  │  ' FAINT separators, tail-segment
// shedding (the first segment always survives). Row 1 = the launch shape
// (Model · Theme · Dir); row 2 = IDENTITY (Acct · Health) — the K3 honest-
// failure law: a FAILED account read says 'unreadable', never not-signed-in.
// chips: { model, critter, critterHue (hex|null), dir, acct: { state:
// 'email'|'none'|'unreadable', text? }, health: null | { verdict, age } }.
function composeStrip(chips, w) {
  const bc = paint(DUNE)
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const inner = w - 2
  const dirShown = chips.dir.length > 24 ? chips.dir.slice(0, 23) + '…' : chips.dir
  const mk = (label, sgr, txt) => ({
    vis: label.length + 1 + txt.length,
    s: faint + label + ' ' + R + sgr + txt + R,
  })
  const sepVis = 5 // '  │  '
  const sep = faint + '  │  ' + R
  // Per-row fit: drop TAIL segments until the row fits the box (the first
  // segment always stays) — an overflowing row would out-width the border.
  const fitRow = segs => {
    const totalVis = n => segs.slice(0, n).reduce((a, s) => a + s.vis, 0) + (n - 1) * sepVis + 2
    let keep = segs.length
    while (keep > 1 && totalVis(keep) > inner) keep--
    return ' ' + segs.slice(0, keep).map(s => s.s).join(sep)
  }
  const row1 = [
    mk('Model', red, chips.model),
    mk('Theme', chips.critterHue ? hexFg(chips.critterHue, ACC.t256) : accentFg(), chips.critter),
    mk('Dir', ivory, dirShown),
  ]
  const row2 = [
    chips.acct.state === 'unreadable'
      ? mk('Acct', paint(AMBERC), 'unreadable') // K3: a failed read never claims not-signed-in
      : mk('Acct', chips.acct.state === 'email' ? ivory : paint(AMBERC), chips.acct.state === 'email' ? chips.acct.text : 'not signed in'),
  ]
  if (chips.health) {
    // The ONE health-chip grammar (frame strip / Helm rail / resume recap):
    // `Health <glyph> <verdict> · <age>`.
    const tone =
      chips.health.verdict === 'certified'
        ? paint(TEALC)
        : chips.health.verdict === 'caution'
          ? paint(AMBERC)
          : paint(CRIMSONC)
    const glyph =
      chips.health.verdict === 'certified' ? '✓' : chips.health.verdict === 'caution' ? '▲' : '✕'
    row2.push(mk('Health', tone, glyph + ' ' + chips.health.verdict + (chips.health.age ? ' · ' + chips.health.age : '')))
  }
  return [
    boxTop(inner, bc),
    boxRow(fitRow(row1), inner, bc),
    boxRow(fitRow(row2), inner, bc),
    boxBot(inner, bc),
  ]
}

// ── the PROJECTS picker view ─────────
// "Anywhere the terminal is launched, choose your repo": rows arrive with
// their display dir PRE-ABBREVIATED by the host (~-abbreviation needs
// homedir — the core stays pure). ↵'s destination semantics stay host-owned.
function composeProjects(projects, selIdx, w) {
  const bc = paint(DUNE)
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const inner = Math.min(w - 2, 76)
  const lines = ['', red + ' ◆ Projects' + R + faint + ' — repos Mercury has worked in' + R, '']
  const rowLines = []
  lines.push(boxTop(inner, bc))
  projects.forEach((p, i) => {
    const sel = i === selIdx
    const caret = sel ? red + '❯ ' + R : '  '
    const base = (sel ? BOLD + ivory : paint(MIDCREAM)) + p.base.slice(0, 24).padEnd(24) + R
    const age = fmtAge(p.ageMs)
    // Narrow guard (the panel-clip bound class): a sub-8-col budget drops
    // the dir column entirely instead of slicing with a negative index.
    // The running indicator (cross-project awareness, law 6): a host row
    // with `running` set paints "N running" in the accent right before the
    // age; a row without it composes the exact bytes it always did.
    const note = p.running ? `${p.running} running` : ''
    let dir = p.dirShown
    const dirBudget = inner - 24 - age.length - 10 - (note ? note.length + 2 : 0)
    if (dirBudget < 8) dir = ''
    else if (dir.length > dirBudget) dir = '…' + dir.slice(-(dirBudget - 1))
    const left = ' ' + caret + base + (dir ? ' ' + faint + dir + R : '')
    const gap = Math.max(0, inner - vis(left) - age.length - 2 - (note ? note.length + 2 : 0))
    rowLines.push(lines.length)
    lines.push(boxRow(clipVis(left + ' '.repeat(gap) + (note ? red + note + R + '  ' : '') + faint + age + R + ' ', inner), inner, bc))
  })
  lines.push(boxBot(inner, bc))
  lines.push('')
  lines.push(faint + ' ↑↓ pick · ↵ open there · esc back' + R)
  return { lines: lines.map(l => '  ' + l), rowLines }
}

// ── the BOOT MENU (the ratified three-panel design; both hosts) ────────────
// Extracted from the launcher's composeMenuWide/composeMenuClassic (the
// share-by-extraction seam the lockup already crossed — §3): ONE
// design, host-injected data. `m`:
//   entries: [{ label, group, summary, valueLabel, valueIsDefault,
//               pinnedVal: string|null, detail: {controls,on,off}|null,
//               detailExtra?: string[] }]
//   selIdx · summary: { profile, harness, integrity, integritySet }
//   environment: { model, critter, critterHue, dirBase, dirTail }
//   statusRight · legend · detailOverride?: string[] (the apply-receipts
//   swap — replaces the SETTING DETAIL body inside the same size-only
//   budget, so the layout tier can never move)
// GENERIC over its host (the MCPs & Skills manager rides the SAME composer
// — L24(5): "the same UI, the same level of polish"): every field below is
// OPTIONAL and absent ⇒ the boot menu's exact bytes —
//   title?: string ('boot menu' — the '⌁ <title>' caption / classic ' · <title>')
//   summaryTitle?: string + summaryRows?: [{ key, value, tone?: 'cream'|
//     'faint'|'teal'|'amber'|'crimson' }] (replace LAUNCH SUMMARY's four
//     rows wholesale; the status registers serve verdict-shaped hosts)
//   noticeLine?: string|null (a LOUD one-sentence disclosure the host must
//     surface at EVERY size: the wide tier already carries it as its
//     summaryRows Notice row; the classic tier paints THIS field as a
//     wrapped teal block above the entries — the host derives both from
//     the ONE upstream notice so the two presentations can never drift.
//     Absent/null ⇒ byte-identical frames.)
//   moreHint?: string (the clamped-detail ellipsis line)
//   entries[i].groupTitle?: string (the section title verbatim — the wide
//     tier otherwise upper-cases `group`) · entries[i].inert?: boolean (a
//     section's honest empty line: faint, never focused — the host keeps
//     the cursor off it, and selIdx -1 composes no detail row)
// Returns { lines, entryLines } — entryLines maps each VISIBLE control-plane
// entry to its absolute line index (the Ink host mounts pointer targets
// there); the classic tier returns the same shape.

// A titled panel: rounded DUNE border, accent title as the first interior
// row. SGR-aware clip — the panel-border backstop (an over-wide row used to
// run straight THROUGH the box edge).
function panelLines(title, contentLines, w) {
  const bc = paint(DUNE)
  const red = accentFg()
  const inner = w - 2
  return [
    boxTop(inner, bc),
    boxRow(' ' + red + BOLD + title + R, inner, bc),
    ...contentLines.map(l => boxRow(clipVis(l, inner - 1), inner, bc)),
    boxBot(inner, bc),
  ]
}

// THE RATIFIED FLOOR (operator-ruled 64×13 for this screen,
// WARN NEVER WALL): below the floor the menu stays FUNCTIONAL — it warns,
// it never locks the operator out, and it never paints a torn frame. The
// preference order, as ratified: works-degraded-with-warning (the classic
// frame with the warn line where it still genuinely operates) → the MICRO
// tier (a windowed, navigable shred: warn header + selected rows + the
// legend) → the one-line tier (identity + the exit keys). Recovery is
// instant both directions (pure re-compose per frame). At/above the floor
// every byte is identical to the pre-floor composition.
const MENU_FLOOR_COLS = 64
const MENU_FLOOR_ROWS = 13
const menuBelowFloor = (cols, rowsAvail) => cols < MENU_FLOOR_COLS || rowsAvail < MENU_FLOOR_ROWS
const menuWantsLine = (cols, rowsAvail) =>
  `wants at least ${MENU_FLOOR_COLS}×${MENU_FLOOR_ROWS} · this window is ${cols}×${rowsAvail}`

function composeBootMenu(cols, rowsAvail, m) {
  // The classic tier's chrome genuinely breaks under 10 rows (the legend —
  // the way-out line — is the first casualty) and under ~48 columns the
  // label+value rows overrun; the MICRO tier takes over there.
  if (rowsAvail < 10 || cols < 48) return composeBootMenuMicro(cols, rowsAvail, m)
  // Measure-then-choose: the wide layout (head first, then headless), the
  // first that actually FITS the live rows — never a clipped legend. Below
  // the floor the classic carries the ONE warn mechanism, so wide yields
  // (a 110-col × 11-row frame degrades to classic+warn deliberately).
  if (cols >= 110 && !menuBelowFloor(cols, rowsAvail)) {
    for (const withHead of [true, false]) {
      const w = composeBootMenuWide(cols, rowsAvail, m, withHead)
      if (w && w.lines.length <= rowsAvail) return w
    }
  }
  return composeBootMenuClassic(cols, rowsAvail, m)
}

// The MICRO tier (A3): rowsAvail < 10 or cols < 48 — every line clipped to
// the columns, never more lines than the window has rows, the selection
// windowed and navigable from 3 rows up, the exit named down to ONE row.
function composeBootMenuMicro(cols, rowsAvail, m) {
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const mid = paint(MIDCREAM)
  const clip = s => (vis(s) <= cols ? s : clipVis(s, cols))
  const rows = Math.max(1, rowsAvail)
  if (rows === 1) {
    // The one-line tier: identity + the exit keys — bare-minimum
    // functional, never a lockout. The WAY OUT sheds LAST: the full line,
    // then the cycle hint drops, then identity — 'esc back' survives to
    // the narrowest sane frame.
    const full = red + '(>_) ' + ivory + 'menu' + R + faint + ' · esc back · ↵ cycles' + R
    const noCycle = red + '(>_) ' + ivory + 'menu' + R + faint + ' · esc back' + R
    const exitOnly = faint + 'esc back' + R
    const line = vis(full) <= cols ? full : vis(noCycle) <= cols ? noCycle : clip(exitOnly)
    return { lines: [line], entryLines: [] }
  }
  const lines = []
  const entryLines = []
  lines.push(clip(red + '(>_) ' + ivory + (m.title ?? 'boot menu') + R + faint + ' · ' + menuWantsLine(cols, rowsAvail) + R))
  const budget = rows - 2 // the warn header + the legend
  if (budget >= 1 && m.entries.length > 0) {
    const sel = Math.max(0, Math.min(m.selIdx ?? 0, m.entries.length - 1))
    const start = Math.max(0, Math.min(sel - (budget >> 1), m.entries.length - budget))
    for (let i = start; i < Math.min(m.entries.length, start + budget); i++) {
      const r2 = m.entries[i]
      const isSel = i === sel
      const lead = isSel ? red + '❯ ' + R : '  '
      const label = (isSel ? ivory : r2.inert ? faint : mid) + r2.label + R
      const val = faint + ' · ' + (r2.pinnedVal !== null && r2.pinnedVal !== undefined ? `env=${r2.pinnedVal} wins` : r2.valueLabel) + R
      entryLines.push({ entry: i, line: lines.length })
      lines.push(clip(lead + label + val))
    }
  }
  lines.push(clip(faint + '↑↓ · ↵ cycles · esc back' + R))
  return { lines, entryLines }
}

function composeBootMenuWide(cols, rowsAvail, m, withHead = false) {
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const mid = paint(MIDCREAM)
  const cream = paint(CREAM)
  const RIGHT_W = 46
  const LEFT_W = Math.min(66, cols - RIGHT_W - 4)
  const row = m.entries[m.selIdx]

  // ── CONTROL PLANE (left): grouped rows, value right-aligned ────────────────
  const cRows = []
  const cRowEntry = [] // per cRows line: the entry index it carries (or -1)
  let selLine = 0
  let lastGroup = null
  m.entries.forEach((r2, i) => {
    if (r2.group !== lastGroup) {
      if (lastGroup !== null) { cRows.push(''); cRowEntry.push(-1) }
      cRows.push(' ' + faint + (r2.groupTitle ?? r2.group.toUpperCase()) + R)
      cRowEntry.push(-1)
      lastGroup = r2.group
    }
    const sel = i === m.selIdx
    //the pin renders in BOTH layouts (canonical-then-legacy is the
    // HOST's resolution — entries carry the resolved pin).
    const pinned = r2.pinnedVal !== null && r2.pinnedVal !== undefined
    const valTxt = pinned ? `env=${r2.pinnedVal} wins` : r2.valueLabel
    const valSGR = pinned || r2.inert ? faint : r2.valueIsDefault ? faint : cream
    // Focused label wears bold + UNDERLINE; an inert entry (a section's
    // honest empty line — the host never rests the cursor on it) is faint.
    const lab = sel ? red + '❯ ' + R + BOLD_UL + ivory + r2.label + R : '  ' + (r2.inert ? faint : mid) + r2.label + R
    const innerW = LEFT_W - 2
    const gap = Math.max(1, innerW - vis(' ' + lab) - valTxt.length - 1)
    if (sel) selLine = cRows.length
    cRowEntry.push(i)
    cRows.push(' ' + lab + ' '.repeat(gap) + valSGR + valTxt + R)
  })
  // WINDOWED VIEWPORT: the row list clips to a SIZE-ONLY budget — the
  // LAYOUT-TIER INVARIANT holds (wide↔classic stays a function of terminal
  // size, never of row count or selection). The window FOLLOWS the
  // selection; honest edge markers count what's hidden.
  const wordH = rasterHard(WORD).lines.length
  const headH = withHead ? 1 + rasterHard(HEADSTD).lines.length : 0
  const leftInteriorBudget = Math.max(9, rowsAvail - headH - wordH - 10 - 3)
  let cShown = cRows
  let cShownEntry = cRowEntry
  let windowLead = 0 // lines the viewport prepends before the shown rows
  if (cRows.length > leftInteriorBudget) {
    const visRows = leftInteriorBudget - 2 // two edge-marker rows
    const start = Math.max(0, Math.min(selLine - (visRows >> 1), cRows.length - visRows))
    const end = start + visRows
    cShown = [
      start > 0 ? ' ' + faint + `… ${start} more above` + R : ' ',
      ...cRows.slice(start, end),
      end < cRows.length ? ' ' + faint + `… ${cRows.length - end} more below` + R : ' ',
    ]
    cShownEntry = [-1, ...cRowEntry.slice(start, end), -1]
    windowLead = 1
  }
  void windowLead
  const leftPanel = panelLines('CONTROL PLANE', cShown, LEFT_W)

  // ── SETTING DETAIL (right top) ─────────────────────────────────────────────
  const textW = RIGHT_W - 5
  const buildDetailRows = r2 => {
    const d2 = r2.detail || null
    const pinned2 = r2.pinnedVal !== null && r2.pinnedVal !== undefined
    const rows2 = []
    rows2.push(' ' + red + '❯ ' + R + BOLD + ivory + r2.label + R)
    rows2.push('')
    rows2.push(' ' + red + 'What it controls' + R)
    for (const l of wrapWords(d2 ? d2.controls : r2.summary, textW)) rows2.push(' ' + mid + l + R)
    rows2.push('')
    rows2.push(' ' + red + 'Current value' + R)
    rows2.push(
      ' ' + cream + r2.valueLabel + R + (pinned2 ? faint + ` · env=${r2.pinnedVal} wins` + R : ''),
    )
    // Runtime deltas slot INSIDE the panel: per-row
    // provenance and the like — plain lines, faint.
    for (const l of r2.detailExtra ?? []) rows2.push(' ' + faint + l + R)
    if (d2) {
      rows2.push('')
      rows2.push(' ' + red + 'When on' + R)
      for (const b of d2.on)
        wrapWords(b, textW - 2).forEach((l, j) =>
          rows2.push(' ' + faint + (j === 0 ? '◦ ' : '  ') + R + mid + l + R),
        )
      rows2.push('')
      rows2.push(' ' + red + 'When off' + R)
      for (const b of d2.off)
        wrapWords(b, textW - 2).forEach((l, j) =>
          rows2.push(' ' + faint + (j === 0 ? '◦ ' : '  ') + R + mid + l + R),
        )
    }
    return rows2
  }
  // No selected row (an empty catalogue, or the cursor parked off an inert
  // line): the detail body is the host's override, else empty — never a
  // read of an undefined entry.
  const dRows = m.detailOverride
    ? [' ' + red + '❯ ' + R + BOLD + ivory + (row ? row.label : '') + R, '', ...m.detailOverride.map(l => ' ' + mid + l + R)]
    : row
      ? buildDetailRows(row)
      : []

  // ── LAUNCH SUMMARY (right mid) — host-derived facts ───────────────────────
  // A host may hand its OWN titled rows (m.summaryTitle + m.summaryRows —
  // the MCPs & Skills manager's NEXT SESSION panel); absent, the boot
  // menu's four rows compose exactly as before.
  const kv = (k, v, tone) => ' ' + faint + k.padEnd(11) + R + (tone || mid) + v + R
  const toneOf = t =>
    t === 'cream'
      ? cream
      : t === 'faint'
        ? faint
        : t === 'teal'
          ? paint(TEALC)
          : t === 'amber'
            ? paint(AMBERC)
            : t === 'crimson'
              ? paint(CRIMSONC)
              : undefined
  const sRows = m.summaryRows
    ? m.summaryRows.map(r2 => kv(r2.key, r2.value, toneOf(r2.tone)))
    : [
        kv('Profile', m.summary.profile),
        kv('Harness', m.summary.harness),
        kv('Integrity', m.summary.integrity, m.summary.integritySet ? cream : undefined),
        kv('Readiness', '', undefined) + paint(TEALC) + '● ready' + R,
      ]
  const summaryPanel = panelLines(m.summaryTitle ?? 'LAUNCH SUMMARY', sRows, RIGHT_W)

  // ── ENVIRONMENT (right bottom) ─────────────────────────────────────────────
  const dirBudget = RIGHT_W - 2 - 1 - 1 - 11 // panel inner − pads − key column
  const fullTail = m.environment.dirTail
  const branchTail = fullTail.includes(' · ') ? fullTail.slice(0, fullTail.indexOf(' · ')) : fullTail
  const dirBase = m.environment.dirBase
  const dirTail =
    dirBase.length + fullTail.length <= dirBudget
      ? fullTail
      : dirBase.length + branchTail.length <= dirBudget
        ? branchTail
        : ''
  const eRows = [
    kv('Mercury', m.environment.model),
    kv('Theme', m.environment.critter, m.environment.critterHue ? hexFg(m.environment.critterHue, ACC.t256) : accentFg()),
    kv('Dir', '', undefined) + ivory + dirBase + R + faint + dirTail + R,
  ]
  const envPanel = panelLines('ENVIRONMENT', eRows, RIGHT_W)

  // ── SETTING DETAIL, assembled under the LAYOUT-TIER INVARIANT ─────────────
  // Layout tier is a function of TERMINAL SIZE only, never of which row is
  // selected: the right column budgets against the left panel's fixed
  // height + a geometry budget; detail past the budget clamps to a faint
  // ellipsis row; a SHORT detail pads to the same size-only budget.
  const word = rasterHard(WORD, wordToneGlow(m.glowWord ?? null))
  const headLines = withHead ? rasterHard(HEADSTD).lines : null
  const chromeRows = (headLines ? 1 + headLines.length : 0) + word.lines.length + 10
  const geometryBudget =
    rowsAvail - chromeRows - summaryPanel.length - envPanel.length - 3
  // The head is decoration; the detail is this screen's JOB — offered only
  // when the tallest detail fits un-clipped (a max over the FIXED menu
  // content, so still selection-invariant).
  const maxDetailRows = Math.max(...m.entries.map(r2 => buildDetailRows(r2).length))
  if (withHead && geometryBudget < maxDetailRows) return null
  const detailBudget = Math.max(
    8,
    leftPanel.length - summaryPanel.length - envPanel.length - 3, // 3 = this panel's border+title rows
    geometryBudget,
  )
  const dShown =
    dRows.length > detailBudget
      ? [...dRows.slice(0, detailBudget - 1), ' ' + faint + (m.moreHint ?? '… (the trail continues — a taller terminal shows it whole)') + R]
      : dRows
  const dPadded = [...dShown, ...Array(Math.max(0, detailBudget - dShown.length)).fill('')]
  const detailPanel = panelLines('SETTING DETAIL', dPadded, RIGHT_W)

  // ── assemble: header · zipped columns · status bar · key legend ────────────
  const lines = []
  if (headLines) lines.push('', ...headLines)
  lines.push('', dividerLine(word.width), '', ...word.lines, '')
  lines.push(faint + '⌁ ' + (m.title ?? 'boot menu') + R)
  lines.push('')
  const zipStart = lines.length
  const rightCol = [...detailPanel, ...summaryPanel, ...envPanel]
  const totalW = LEFT_W + 2 + RIGHT_W
  // UNIFORM-WIDTH zip rows (the border-break fix): right-pad every zipped
  // row to the block width so the centering map can never shear a panel edge.
  lines.push(...zipCols(leftPanel, rightCol, LEFT_W, 2).map(l => padVis(l, totalW)))
  const bc = paint(DUNE)
  lines.push(
    boxTop(totalW - 2, bc),
    // Clipped like every panel row (the border backstop): a host's long
    // status fact must never run through the box edge.
    boxRow(
      clipVis(' ' + paint(TEALC) + '● ' + R + ivory + 'System ready' + R + faint + `  │  ${m.statusRight}` + R, totalW - 3),
      totalW - 2,
      bc,
    ),
    boxBot(totalW - 2, bc),
  )
  lines.push(faint + m.legend + R)
  // Two-level centering (the lockup's own frame rule).
  const blockW = Math.max(...lines.map(vis))
  const left = Math.max(0, Math.floor((cols - blockW) / 2))
  const centered = lines.map(l => {
    const w = vis(l)
    const pad = left + (w < blockW ? Math.max(0, Math.floor((blockW - w) / 2)) : 0)
    return ' '.repeat(pad) + l
  })
  // entryLines: control-plane interior rows sit inside the left panel at
  // zipStart + 2 (boxTop + title) + shown-index.
  const entryLines = []
  cShownEntry.forEach((entryIdx, k) => {
    if (entryIdx >= 0) entryLines.push({ entry: entryIdx, line: zipStart + 2 + k })
  })
  return { lines: centered, entryLines }
}

function composeBootMenuClassic(cols, rowsAvail, m) {
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const LW = Math.max(...m.entries.map(r => r.label.length))
  // Build the FULL list first (group labels + rows), tracking the selection,
  // then WINDOW it to the terminal: short windows scroll the list behind
  // faint ↑/↓ more indicators instead of losing the menu entirely.
  const listLines = []
  const listEntry = []
  let selPos = 0
  let lastGroup = null
  m.entries.forEach((row, i) => {
    if (row.group !== lastGroup) {
      listLines.push(faint + (row.groupTitle ?? row.group) + R)
      listEntry.push(-1)
      lastGroup = row.group
    }
    const sel = i === m.selIdx
    const pinned = row.pinnedVal !== null && row.pinnedVal !== undefined
    let line =
      (sel ? red + '❯ ' + R : '  ') +
      (sel ? BOLD_UL + ivory + row.label + R : (row.inert ? faint : paint(MIDCREAM)) + row.label + R) +
      ' '.repeat(Math.max(0, LW - row.label.length)) +
      '  ' + (row.valueIsDefault ? faint : paint(CREAM)) + row.valueLabel + R
    if (pinned) line += faint + ' · env=' + row.pinnedVal + ' wins' + R
    if (sel) selPos = listLines.length
    listEntry.push(i)
    listLines.push(line)
  })
  // THE NOTICE BLOCK (the noticeLine contract above): the classic tier's
  // half of the every-size disclosure — wrapped teal, above the entries.
  // Budgeted to the genuine slack: the way-out chrome (4 rows once the
  // notice replaces the post-header blank) and the list floor (5) never
  // yield; a cramped frame clips the wrap to its slack with an ellipsis
  // (at least ONE teal line paints in every classic frame), and the
  // separating blank returns only when a row remains for it.
  // A CONFIRMATION override outranks the ambient notice while it stands:
  // the wide tier paints every override in the SETTING DETAIL panel; this
  // tier has no panel, so a host that marks its override a CONFIRMATION
  // (detailOverrideConfirms — the prune door) rides the notice block —
  // before this, the prune confirmation's body (the one transcript-deleting
  // door) was INVISIBLE at classic widths and ↵ committed from an
  // unconfirmed frame. Ordinary informational overrides (the logins detail
  // bodies) stay wide-tier-only: at classic sizes they would eat the list.
  const noticeText = m.detailOverride && m.detailOverrideConfirms ? m.detailOverride.filter(Boolean).join(' ') : m.noticeLine
  const noticeWrapped = noticeText ? wrapWords(noticeText, Math.max(20, cols - 4)) : []
  const noticeBudget =
    noticeWrapped.length > 0
      ? Math.max(1, Math.min(noticeWrapped.length, rowsAvail - 4 - 5))
      : 0
  const noticeClipped = noticeBudget < noticeWrapped.length
  const noticeLines = noticeWrapped.slice(0, noticeBudget).map((l, i) => {
    const text = noticeClipped && i === noticeBudget - 1 ? clipVis(l, Math.max(1, cols - 5)) + '…' : l
    return paint(TEALC) + text + R
  })
  const noticeBlank = noticeLines.length > 0 && rowsAvail - 4 - 5 - noticeBudget >= 1
  const chrome =
    noticeLines.length > 0
      ? 4 + noticeBudget + (noticeBlank ? 1 : 0) + 2 // header + notice(+blank) + post-list blank + summary + legend + slack
      : 7 // header + blanks + summary + legend + slack
  const listBudget = Math.max(5, rowsAvail - chrome)
  let shownList = listLines
  let shownEntry = listEntry
  if (listLines.length > listBudget) {
    const win = Math.max(3, listBudget - 2) // 2 rows reserved for the indicators
    const start = Math.min(Math.max(0, selPos - Math.floor(win / 2)), listLines.length - win)
    const end = start + win
    shownList = [
      faint + (start > 0 ? `↑ ${start} more` : ' ') + R,
      ...listLines.slice(start, end),
      faint + (end < listLines.length ? `↓ ${listLines.length - end} more` : ' ') + R,
    ]
    shownEntry = [-1, ...listEntry.slice(start, end), -1]
  }
  const lines = []
  lines.push(red + '(>_) ' + ivory + 'MERCURY' + R + faint + ' · ' + (m.title ?? 'boot menu') + R)
  if (noticeLines.length > 0) {
    // The notice takes the post-header blank's row (cramped frames have no
    // spare); its own separating blank returns when a row remains.
    lines.push(...noticeLines)
    if (noticeBlank) lines.push('')
  } else {
    lines.push('')
  }
  const listStart = lines.length
  lines.push(...shownList)
  lines.push('')
  const rowsW = cols - 4
  const clamp = s => (s.length > rowsW ? s.slice(0, rowsW - 1) + '…' : s)
  // A3 (the ratified floor): below 64×13 the summary row carries the ONE
  // warn line — the menu keeps operating, the warning says why it is
  // cramped, and the row it spends is the least load-bearing one.
  lines.push(
    faint +
      clamp(
        menuBelowFloor(cols, rowsAvail)
          ? `${m.title ?? 'boot menu'} ${menuWantsLine(cols, rowsAvail)}`
          : m.entries[m.selIdx] ? m.entries[m.selIdx].summary : '',
      ) +
      R,
  )
  lines.push(faint + (m.legendClassic ?? m.legend) + R)
  const blockW = Math.max(...lines.map(vis))
  const left = Math.max(0, Math.floor((cols - blockW) / 2))
  // No emitted line may exceed the frame — EXCEPT the legend (the last
  // line): a host value column the label budget never measured (a long
  // entry valueLabel) otherwise overruns the columns and the terminal's
  // wrap breaks the grid. The legend is exempt because clipping it can eat
  // 'esc back' — the way out sheds LAST (the micro tier's law); an overwide
  // legend wraps, which is ugly but never a wall.
  const legendAt = lines.length - 1
  const centered = lines.map((l, i) => {
    const padded = ' '.repeat(left) + l
    if (i === legendAt) return padded
    return vis(padded) <= cols ? padded : clipVis(padded, cols)
  })
  const entryLines = []
  shownEntry.forEach((entryIdx, k) => {
    if (entryIdx >= 0) entryLines.push({ entry: entryIdx, line: listStart + k })
  })
  return { lines: centered, entryLines }
}

// ── compose the lockup (the canonical Boot composition; both hosts) ────────
// opts: { cardRows: [{icon,label,ctx,dim?}], cardSel, hintSegments,
//         tinyHint, stripLines: w => lines, hintCinematic? }.
// Returns { lines, wordRow, cardShown, actionLines } — wordRow is the
// wordmark centre INDEX within the block (the ONE placed brand
// row rides it), actionLines the block line index of each card action row
// (the Ink adapter mounts its InteractiveRow pointer targets there).
function composeLockup(cols, rows, opts) {
  // GLOW: the hosts arm greeting phases (glowPhaseAt against WORD_W /
  // CARD_LABEL_W) and pass them per compose; null (or absent) is the
  // settled composition, byte-identical to the pre-GLOW frame.
  const word = rasterHard(WORD, wordToneGlow(opts.glowWord ?? null))
  const std = rasterHard(HEADSTD)

  const fitsHead =
    cols >= Math.max(std.width, word.width) + 2 &&
    rows >= std.lines.length + word.lines.length + 8

  const head = fitsHead ? std : null

  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const faint = hexFg(FAINT, T256.faint)
  // The ready line rides the shared grammar (composeHint above) with the
  // HOST's injected key segments; ↑↓ choose joins when the card shows.
  // hintCinematic: the launcher's animation-first frame
  // composes the FULL block for geometry (one placement, zero seam jump)
  // but paints only the hero — its hint must not advertise the unpainted
  // card's keys, so the '↑↓ choose' appendix is suppressed while every
  // other line stays byte-identical to the landing composition.
  const hintFor = withCard => composeHint(opts.hintSegments, withCard && !opts.hintCinematic)
  const blank = ''

  // Card geometry — shared by the head tier and the HEADLESS-CARD tier below.
  // Two card tiers (#179 grew the card to 6 rows): FULL keeps the per-row
  // separators (the mockup look); TIGHT drops just the separators when the
  // rows budget is 2–5 lines short — the card survives instead of vanishing.
  const nCardRows = opts.cardRows.length
  const cardHFull = nCardRows > 0 ? nCardRows * 2 + 1 : 0
  const cardHTight = nCardRows > 0 ? nCardRows + 2 : 0
  const stackOf = ch => (ch > 0 ? ch + 4 + 2 : 0) // + strip (2 content rows) + blanks
  // Head-tier budgets (art + word + card).
  const cardW = Math.max(46, Math.min(84, cols - 36))
  const baseNeed = std.lines.length + word.lines.length + 8
  // The head card-tiers bill their REAL rows, as composed below: the
  // structure (blank · head · blank · divider · blank · word · blank ·
  // hint = head+word+6) plus the appendix (blank · card · the 4-row
  // strip). The old padded budget (baseNeed + stackOf) demanded 4 phantom
  // rows, so a populated SEVEN-row card at 120x40 shed the strip the same
  // home kept at 100x30 — the bigger terminal showed less (field return
  // F3). fitsHead's +8 keeps its breathing for the art-only tiers, and the
  // headless family below keeps its own ratified budgets untouched.
  const cardStack = ch => std.lines.length + word.lines.length + 6 + 1 + ch + 4
  const wantFull =
    head !== null && nCardRows > 0 && cols >= cardW + 2 && rows >= cardStack(cardHFull)
  const wantTight =
    head !== null && !wantFull && nCardRows > 0 && cols >= cardW + 2 && rows >= cardStack(cardHTight)
  // HEAD-BARE tier (F2): head + tight card with the
  // STRIP shed — the strip (a status readout, redundant with the landing's
  // live chips) degrades before the brand art does, exactly as it already
  // does inside the headless family (hlBare). Claims the band where the head
  // fits with the tight card but not the strip (120×38 laptops); every
  // geometry that fits more keeps its richer tier above.
  const wantBare =
    head !== null && !wantFull && !wantTight && nCardRows > 0 && cols >= cardW + 2 &&
    rows >= baseNeed + cardHTight + 1
  // HEADLESS-CARD budgets (product-study r3 — the ladder inversion): the head
  // ART must degrade before the ACTIONS. When the full stack can't fit, drop
  // the art and keep wordmark + hint + launcher card — 80×24 (macOS default)
  // and 120×40 laptops get the functional arrival instead of pure art. The
  // strip sheds first (hlBare), then the card falls back to the word-only tier.
  const hlCardW = Math.max(46, Math.min(84, cols - 4))
  const wordBase = word.lines.length + 8
  const hlColsOk = nCardRows > 0 && cols >= hlCardW + 2 && cols >= word.width + 4
  const headStackFits = wantFull || wantTight || wantBare
  const hlFull = !headStackFits && hlColsOk && rows >= wordBase + stackOf(cardHFull)
  const hlTight = !headStackFits && !hlFull && hlColsOk && rows >= wordBase + stackOf(cardHTight)
  const hlBare =
    !headStackFits && !hlFull && !hlTight && hlColsOk && rows >= wordBase + cardHTight + 1
  const headlessCard = hlFull || hlTight || hlBare
  // Record where the WORDMARK's centre line lands within the
  // block — paintView turns it into the absolute placedBrandRow the ripple
  // and the handoff hold park the brand on (one shared placement, no jump).
  const wordCentre = Math.floor(word.lines.length / 2)
  let block
  let wordRow
  let cardShown
  let cardAt = -1
  let cardIdx = []
  if (head && (headStackFits || !headlessCard)) {
    // STANDARD tier: art + word (+ the card/strip when the stack genuinely
    // fits — the 100×34 keypress legs ride whichever tier shows the ↵ path).
    const wantCard = headStackFits
    cardShown = wantCard
    block = [
      blank,
      ...head.lines,
      blank,
      dividerLine(word.width),
      blank,
      ...word.lines,
      blank,
      hintFor(wantCard),
    ]
    if (wantCard) {
      const card = composeCard(opts.cardRows, opts.cardSel, cardW, wantFull, opts.glowRow ?? null)
      block.push(blank)
      cardAt = block.length
      cardIdx = card.rowLines
      block.push(...card.lines)
      if (!wantBare) block.push(...opts.stripLines(cardW))
    }
    wordRow = head.lines.length + 4 + wordCentre
  } else if (headlessCard) {
    // HEADLESS-CARD tier: actions outrank art.
    cardShown = true
    const card = composeCard(opts.cardRows, opts.cardSel, hlCardW, hlFull, opts.glowRow ?? null)
    block = [
      blank,
      dividerLine(word.width + 2),
      blank,
      ...word.lines,
      blank,
      hintFor(true),
      blank,
    ]
    cardAt = block.length
    cardIdx = card.rowLines
    block.push(...card.lines)
    if (!hlBare) block.push(...opts.stripLines(hlCardW))
    wordRow = 3 + wordCentre
  } else if (rows >= 11 && cols >= word.width + 4) {
    cardShown = false
    block = [blank, dividerLine(word.width + 2), blank, ...word.lines, blank, hintFor(false)]
    // THE HONEST CUT (prove-face-fit-floor): the whole card just vanished —
    // at 24 rows exactly the macOS Terminal default once the card reached
    // 10 rows — and this tier said nothing about it. One line names what is
    // hidden, what it needs and what this window is (the board's own
    // too-small precedent); the road key (m) already rides the hint line
    // above, present-moves-honest. Sheds whole when even the short form
    // cannot fit the width — never a torn line.
    if (nCardRows > 0) {
      const cardFloor = wordBase + cardHTight + 1
      const cutFull = faint + `the ${nCardRows}-row card needs ${cardFloor} rows — this window is ${cols}×${rows}` + R
      const cutShort = faint + `card hidden — needs ${cardFloor} rows` + R
      if (vis(cutFull) <= cols) block.push(blank, cutFull)
      else if (vis(cutShort) <= cols) block.push(blank, cutShort)
    }
    wordRow = 3 + wordCentre
  } else {
    // THE TINY TIER: one honest line, never a torn one. The
    // full line is 14 + hint columns; below that the HINT sheds first (↵
    // still works — the hint is the redundant part), then the wordmark,
    // leaving the mark alone — identity degrades last, and no tier ever
    // composes wider than the terminal (a >cols line wraps at the host and
    // tears every row under it).
    cardShown = false
    const tinyFull = red + '(>_) ' + ivory + 'MERCURY' + R + '  ' + faint + opts.tinyHint + R
    const tinyWord = red + '(>_) ' + ivory + 'MERCURY' + R
    const tinyMark = red + '(>_)' + R
    block = [vis(tinyFull) <= cols ? tinyFull : vis(tinyWord) <= cols ? tinyWord : tinyMark]
    wordRow = 0
  }

  // ONE shared frame: the head + rule + wordmark all render
  // at the reference's full content width, so the reference's OWN internal
  // alignment (head slightly left of the rule/wordmark axis) ships verbatim —
  // no per-block re-centering, no hand nudges. The frame centers once.
  const blockW = Math.max(...block.map(vis))
  const left = Math.max(0, Math.floor((cols - blockW) / 2))
  const lines = block.map(l => {
    const pad = left + Math.max(0, Math.floor((blockW - vis(l)) / 2))
    return ' '.repeat(pad) + l
  })
  return {
    lines,
    wordRow,
    cardShown,
    actionLines: cardAt >= 0 ? cardIdx.map(k => cardAt + k) : [],
  }
}

  return {
    R, BOLD, BOLD_UL, DIM,
    rgbFg, rgbBg, hexFg, fg256ish, paint, paintBg,
    rasterHard, dividerLine, wordTone, wordToneGlow, rampLabel, rampSample, sampleFace,
    boxTop, boxBot, boxSep, boxRow, clipVis,
    composeHint, composeCard, composeStrip, composeProjects, composeLockup, placeBlock,
    composeBootMenu, composeBootMenuWide, composeBootMenuClassic, panelLines,
    vis, cpWidth, MARK_RE, padVis, wrapWords, zipCols, mixc,
    T256, CREAM, RED, VOID, FAINT, IVORY, MIDCREAM, DEEPRED, MIDRED, DUNE, PX,
    TEALC, AMBERC, CRIMSONC,
    // GLOW: the resolved accent family (main/deep/soft/ramp/t256*) + the
    // family accent hex — the driver's own hand-composed lines (brand tail,
    // ripple hold) speak the same accent the compose does.
    ACCENT: ACC, ACCENT_HEX: ACC_HEX, accentFg,
  }
}

export { HEADSTD, WORD, MENU, MODEL_NAMES, RAMP, RAMP_FIXTURE, CAPABILITY_TRUTH, ACCENT_FAMILIES, DEFAULT_CRITTER, vis, cpWidth, MARK_RE, padVis, wrapWords, zipCols, placeBlock, mixc, rampSample }

// (There is no vignette canvas sampler — no vignetteToneAt/
// vignetteCellTone, no GRAD_BAND/GRAD_EDGE pair — under the
// flat-ground law: no host paints a field background;
// composed glyphs ride the shared GROUND above. The approved panel plate
// is the pinned PLATE_TONE.)
