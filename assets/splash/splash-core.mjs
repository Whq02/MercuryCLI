const T256 = {"cream":254,"ivory":254,"red":167,"faint":244,"dim":247,"dimred":88,"midred":124,"dune":238,"teal":72,"amber":179,"crimson":167,"dark":233,"black":16}
const CREAM = [240, 232, 214]
const RED = [221, 68, 68]
const VOID = [13, 24, 27]
export const GROUND = VOID
export const GROUND_FAMILIES = {
  dark: [13, 24, 27],
  'true-black': [0, 0, 0],
}
export function adoptGroundFamily(name) {
  const family = GROUND_FAMILIES[name] ?? GROUND_FAMILIES.dark
  VOID[0] = family[0]
  VOID[1] = family[1]
  VOID[2] = family[2]
}
const FAINT = '#71807B'
const IVORY = '#EDE8DD'

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

const WORD = [
  'RR.RR...RRRRR...RRRRR...RRRRR...R...R...RRRRR...R...R',
  'RRRRR...R.......R...R...R.......R...R...R...R...R...R',
  'R...R...RRRR....RRRR....R.......R...R...RRRR.....RRR.',
  'R...R...R.......R..R....R.......R...R...R..R......R..',
  'd...d...ddddd...d...d...ddddd...ddddd...d...d.....d..',
  '.....................................................',
]

const MIDCREAM = [168, 152, 128]
const DEEPRED = [123, 50, 50]
const MIDRED = [172, 59, 59]
const DUNE = [47, 75, 82]
const PX = { E: CREAM, e: MIDCREAM, R: RED, r: DEEPRED, d: MIDRED }

const TEALC = [63, 191, 160]
const AMBERC = [219, 161, 61]
const CRIMSONC = [232, 85, 106]

const MENU = [
  {"env":"MERCURY_WARDS","label":"Content-rule wards","group":"trust combo","summary":"denies edits/commands that break the mechanical house rules (stray hex colors · emoji in TUI code · force-push to main) and teaches the fix","detail":{"controls":"Deterministic rules over pending tool calls: a violating edit or command is denied with a short teaching note (which rule, what to do instead). Project rules extend via .mercury/wards.json; rules cost nothing until violated. Pairs with the self-check gate + Debug tool — the trust combo.","on":["new hex outside the theme tokens, emoji in TUI sources, and force-pushes to main are denied at the moment of the call","denials name the rule and the compliant alternative"],"off":["no content rules — the gate-time ratchets remain the only backstop"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_DAP","label":"Debug tool","group":"trust combo","summary":"a debugger the agent can drive (breakpoints, stepping, variables, evaluate) instead of print statements","detail":{"controls":"The Debug tool speaks the Debug Adapter Protocol to debuggers (Python via debugpy, native code via lldb-dap). Launching a program under the debugger always asks permission first.","on":["the Debug tool joins the catalog","launch asks permission like any command execution","inspection (stacks, variables) rides the permitted session"],"off":["the tool is absent — identical to a build without it"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_LSP_CPP","label":"C/C++ IDE lane (clangd)","group":"trust combo","summary":"C/C++ diagnostics with clang-tidy, rename, and source ⇄ header navigation through clangd","detail":{"controls":"The C/C++ language lane of the IDE bridge: finds clangd (PATH · Xcode · Homebrew llvm), starts it on the first C/C++ file touched, and answers through LspRead and LspRename. A compile database sharpens it when present (shown in /health).","on":["C/C++ files get diagnostics · rename · code actions · source ⇄ header jumps","clang-tidy findings ride the diagnostics","no clangd installed ⇒ the lane is inactive"],"off":["C/C++ files fall back to plain-text editing — no language server"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_SKIP_PERMISSIONS","label":"Sovereign mode","group":"trust combo","summary":"no permission question is asked — not for files, commands, or computer use; you take the wheel","detail":{"controls":"Standing consent for interactive boots: skips file, command, and computer use prompts. Launch confirmation, root notice, deny rules, and computer-use guards still apply; headless runs and daemon workers ignore it.","on":["crimson banner; computer use included"],"off":["prompts asked; --sovereign still works"]},"defaultFollows":null,"warnWhenOn":"nothing asks or stops you — every action runs as you","choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_COMPUTER_USE","label":"Computer use","group":"computer use","summary":"the model sees the screen and drives the mouse and keyboard in the application in front, on a machine that has the desktop driver — off removes the Computer tool from new sessions","detail":{"controls":"Whether new sessions carry the Computer tool: screenshots, clicks, typed text, key chords, scrolls and drags in the application in front, on every model route that receives images. On is the default wherever the desktop driver resolves; a machine without the driver never sees the tool. How consent works is the Access type row below: asks, permissive or full, its default following Sovereign mode. Off removes the tool before any driver is touched — the rest of Mercury does not depend on it.","on":["the Computer tool is in the catalog when the desktop driver resolves","consent follows the Access type row below: the first act of the session asks by the application's name, or the application in front when the turn began never asks, or nothing asks; under Sovereign mode nothing asks","esc or ctrl+c ends the act in flight and the turn; one session drives at a time"],"off":["the Computer tool is absent from new sessions — identical to a build without it","no desktop driver is loaded"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_COMPUTER_ACCESS","label":"Access type","group":"computer use","summary":"asks: the first act of the session asks · permissive: the application in front when the turn began never asks, any other asks once · full: nothing asks","detail":{"controls":"How the Computer tool gets your consent. asks (the default): the first act of the session shows the card, which names the application in front and the act; a Yes covers every application for the session, and the timed grants cover every application for their span. permissive: the application in front at the turn's first Computer call — a screenshot counts — is the turn's home application, and acts in it never ask; an act that lands in any other application asks once, the same card, a Yes covering every application for the session; a new turn records a new home application. full: nothing asks. With Sovereign mode on nothing asks whatever is saved here; the saved value applies when Sovereign mode is off. Whatever the value, a deny rule in a settings file refuses its application, the terminal running Mercury is never typed into, an application that moved in front between the check and the act is refused, and one session drives at a time.","on":["asks: the first act of the session asks by the application's name (never under Sovereign mode, where nothing asks)","permissive: acts in the application in front when the turn began never ask; any other application asks once (never under Sovereign mode)","full: no act asks, in any application"],"off":["the default follows Sovereign mode: asks with it off, full with it on","a deny rule in a settings file still refuses; the terminal running Mercury and an application that moved in front are still refused"]},"defaultFollows":{"env":"MERCURY_SKIP_PERMISSIONS","value":"1","label":"default (full · sovereign mode)"},"warnWhenOn":null,"choices":[{"v":null,"l":"default (asks)"},{"v":"asks","l":"asks"},{"v":"permissive","l":"permissive"},{"v":"full","l":"full"}]},
  {"env":"MERCURY_SAMPLES","label":"Samples","group":"samples","summary":"a page the model draws when you ask to see something; your marks come back","detail":{"controls":"Whether new sessions can keep samples. Off is the default: no sample can be made and nothing listens. On, the model draws a page in an Eval cell only when you ask to see something — a design, a mockup, a report to look at — keeps it under the session, and opens it in your browser; you click a spot and write a comment, add a note, approve or ask for changes, and the marks come back into the session as one message. Every version is kept per session; the same name is the next version.","on":["Eval cells gain sample(), and the tool is told to use it only when you ask to see something","each sample is a row under the composer and in /samples; Enter opens it in your browser","a loopback listener serves the page while the session runs, and your marks come back as one message"],"off":["no sample can be made: the bridge call, the listener, the rows and /samples are absent","identical to a build without samples, but for one note to the model, when a message says \"sample\", that Samples is off and how it turns on"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_SESSION_SUBAGENTS","label":"Crewmates","group":"agents","summary":"whether a session may spawn crewmates — off removes the Crewmate tool from its roster and closes every spawn road; the concourse itself keeps launching sessions","detail":{"controls":"The crewmates switch of the sessions born after this choice. On (the default): the Crewmate tool is in the roster and the model delegates as it does today. Off: the Crewmate tool is absent from the roster — the model never sees it — and every road that would spawn a crewmate from inside the session (the tool, a skill fork, the fleet tools) answers one receipt naming /crewmates and this menu. Inside a session, /crewmates on|off (or this row, opened there) flips it at the next turn boundary — the tool leaves or rejoins the roster, reasoning restarts on the next turn, and a spawn already running finishes.","on":["the Crewmate tool is in the roster; skills and the fleet tools may spawn","a running session flips it any time with /crewmates off"],"off":["no Crewmate tool in the roster; every spawn road answers \"crewmates are off for this session\"","the concourse still launches sessions and crew seats","flip it back inside a session with /crewmates on"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_LAUNCH_RIPPLE","label":"Launch animation","group":"miscellaneous","summary":"the splash ripple on launch — turn off for the fastest boot handoff","detail":{"controls":"The circuit-trace ripple the splash plays while handing the session over. Off is the fast-boot lever: the splash paints once and hands over immediately. Reduced-motion (MERCURY_REDUCED_MOTION=1) also suppresses it; MERCURY_SPLASH=off skips the splash entirely.","on":["the authored launch ripple on truecolor terminals"],"off":["no animation — the fastest handoff to the session"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (on)"},{"v":"0","l":"off"}]},
  {"env":"MERCURY_GODOT","label":"Godot language lanes","group":"miscellaneous","summary":"GDScript IDE + debugger through your running Godot editor — outline, member search, navigation, breakpoints","detail":{"controls":"Arms both Godot lanes: the GDScript language server (outline · member search · navigation inside the Godot editor over loopback :6005) and the godot debug adapter (:6006) for the Debug tool. Activates in projects with project.godot when the editor is open; if the editor is closed, calls return a setup note immediately. Pairs with the Godot control surface (VULCAN) below.","on":[".gd files get the GDScript IDE ops through LspRead and LspRename","the Debug tool gains the 'godot' adapter (breakpoints in the running editor)","no project.godot or no running editor ⇒ an honest teaching note"],"off":["no Godot servers are ever dialed — identical to a build without it"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_GODOT_TOOLS","label":"Godot control surface (VULCAN)","group":"miscellaneous","summary":"full editor control for Godot projects — scenes, nodes, resources, play-testing, runtime inspection, input simulation","detail":{"controls":"The agent drives your running Godot editor directly: scene and node editing (every change is one Ctrl+Z undo step), scripts, resources, animation, physics, audio, tilemaps, shaders — plus play-testing with live game inspection and input simulation. Arming it also shifts agent behavior: sessions and spawned crewmates learn to prefer editor state over hand-editing scene files. Needs the bundled mercury_vulcan addon installed in the project (the tool installs it on ask) and the editor open. Local and sandboxed: a token-authed loopback connection only; running code or simulating input always asks permission first. Pairs with the Godot language lanes above (symbols + breakpoints stay with LspRead and Debug).","on":["the Godot tool joins the catalog for the session; outside a Godot project it answers with a teaching note, and a project created mid-session is found at once","reads are free; edits ask like file edits and are undoable in the editor; play/input/execute always ask","agents shift behavior: editor-first workflow, play-test natively, memory keeps project facts"],"off":["no Godot tool, no connection, no addon writes — identical to an unarmed build"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_UNITY","label":"Unity dev lanes","group":"miscellaneous","summary":"C# IDE + attach-to-editor debugging + editor bridge (play/scenes/tests) + headless test/build profiles for Unity projects — nothing is ever installed or run for you without asking","detail":{"controls":"Arms the Unity lanes in a project with Assets/ + ProjectSettings/: the C# language server lane (your own csharp-ls or OmniSharp from PATH — never auto-installed; /health teaches the install line when absent), the Debug tool's `unity` adapter (attaches to your RUNNING editor via the official Unity VS Code extension's adapter — the editor hosts the debuggee, so every gesture is an attach), the `Unity` tool driving your running editor over a token-authed loopback bridge (play mode, scenes, hierarchy, console, Test Runner — needs the bundled bridge package installed in the project, which the tool does on ask; play/test gestures always ask permission), and headless -batchmode test/build launch profiles the tool hands you to run yourself. Unity's own licensing applies to headless editor runs; if a run fails with Unity's licensing error, activating a license is yours to do (Unity Hub or -serial) — Mercury never checks or manages licenses, and never launches or installs the editor.","on":[".cs files in Unity projects get IDE ops through LspRead and LspRename (csharp-ls/OmniSharp from PATH)","the Debug tool gains the 'unity' adapter — breakpoints in your running editor (port from Library/EditorInstance.json)","the `Unity` tool joins the catalog in Unity projects — play/scenes/hierarchy/console/test runs through your running editor (bridge package installed on ask; reads are free, everything else asks)","headless test/build profiles appear; running them stays your act (the exact command is printed, license disclaimer included)"],"off":["no Unity surface exists — identical to a build without it"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_BLENDER","label":"Blender dev lanes","group":"miscellaneous","summary":".blend awareness + Blender bridge (scene/render/python) + headless render/python profiles + the debugpy attach recipe — Blender located (app bundle counts); never installed or enabled for you, started only with no window by the Blender tool","detail":{"controls":"Arms the Blender lanes: .blend discovery (bounded), the app located your way — a PATH blender, /Applications/Blender.app (the normal Mac install), Program Files, or a MERCURY_BLENDER_BIN pin — with its version probed, headless --background render/python launch profiles the tool hands you to run yourself (arguments in documented order — output before frame), the debugpy attach recipe: one line starts a listener inside Blender, then the Debug tool attaches over the landed debugpy road (the bundled debugpy serves when this build carries it), and the `Blender` tool driving your running Blender over a token-authed loopback bridge (scene/objects truth, blend opens, still renders, report tail, python_run — needs the bundled add-on installed to the user addon home, which the tool does on ask, and ENABLED in Blender's Preferences, which stays your act; python_run and renders always ask permission). Mercury never installs or enables Blender, and starts it only with no window, when the Blender tool is called.","on":["/health gains the Blender lane row (path + version, or the honest install line)","headless render/python profiles appear; running them stays your act (the exact command is printed)","the debug recipe row teaches listen-then-attach (breakpoints in your addon/script files)","the `Blender` tool joins the catalog beside .blend files, or anywhere Blender is located — scene/objects/render truth, blend opens, still renders, report tail, python_run through your running Blender (add-on installed on ask, enabled by you; reads are free, everything else asks)"],"off":["no Blender surface exists — identical to a build without it"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_ASEPRITE","label":"Aseprite dev lanes","group":"miscellaneous","summary":"sprite awareness + the Aseprite batch door (sprite census, PNG/GIF/sprite-sheet exports, new sprites, Lua scripts) — Aseprite located (Steam and itch installs count), never installed or launched as a GUI for you","detail":{"controls":"Arms the Aseprite lanes: .aseprite/.ase discovery (bounded), the app located your way — a PATH aseprite, /Applications/Aseprite.app (the direct download), the Steam library, the win32 installer/itch homes, or a MERCURY_ASEPRITE_BIN pin (the road for source builds) — with its version probed, and the `Aseprite` tool driving the app's own batch mode: sprite census (layers, tags, frames, size), exports with the CLI options (scaling, layer/tag selection, split files, sprite-sheet layouts with JSON metadata), new sprites, and Lua scripts. Every operation is a bounded background run of `aseprite -b` — the GUI is never started. Exports and new sprites ask permission naming the destination; running a script always asks (it is code). Mercury never installs or launches Aseprite for you.","on":["the `Aseprite` tool joins the catalog beside sprite files, or anywhere the app is located (creating from nothing works)","sprite census reads are free; exports and new sprites ask naming their files; Lua scripts always ask","no Aseprite on the box ⇒ honest teaching notes naming every install road"],"off":["no Aseprite surface exists — identical to a build without it"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"1","l":"on"}]},
  {"env":"MERCURY_CAP_FAILOVER","label":"Cap failover posture","group":"miscellaneous","summary":"when the usage window of the family you run on caps out: the SLOT rung always asks first (a one-key switch to the same family's other signed-in slot with headroom; auto switches it unattended) · offer (default) adds the one-keypress cross-family handoff card to another signed-in family — nothing moves without your confirm · off waits for reset instead · auto hands off unattended and returns on the observed reset","detail":{"controls":"What happens when the usage window of the family the session runs on runs out mid-work — the same for every signed-in family, no favourite. TWO rungs. The SLOT rung (within the family — Anthropic's sign-in ⇄ managed key, OpenAI's subscription ⇄ API key): whenever the walled family's OTHER slot is signed in with headroom, the wall presents a one-key slot-switch card at EVERY posture — off included (the wall is never a dead end); at auto the slot switches unattended, receipted on the wall row and in the slot state. Nothing signs out; the next turn rides the other slot. The CROSS-FAMILY rung: offer (the default) — a reached window on the home family presents a one-keypress card (family · window · reset time · spend posture) that opens the model-transition preview; confirming hands the session to the readiest usable lane of the OTHER signed-in families — the most recent sign-in first — at a safe boundary; no usable second lane, no card. off — never leaves the family, never offers; work waits for the reset. auto: a reached window hands off unattended (daemon/overnight runs) — 80% and 90% warnings are words only. Return is symmetric: once the home family's window is OBSERVED to reset (a fresh reply says so, or the provider's own stated reset moment passes) and its credential is still signed in, the same posture offers or executes the way home. Signing the home family out ends the handoff — there is no home to return to. A slot switch back is the same one key (or s on the family's row in /logins) once the walled window resets.","on":["offer (the default): reached windows on the family you run on present the one-keypress handoff card to another signed-in family — nothing moves without your confirm, and no card appears without a usable second lane","auto: a walled slot switches to its family sibling unattended, and a capped family hands off cross-family at a safe boundary — receipted both ways","on the home window's observed reset, the same posture brings work home to the family it left"],"off":["the slot rung still asks: a walled slot with a signed-in sibling shows the one-key switch card","cross-family: never switches, never offers — a capped family waits for its reset (the pre-change default, selectable exactly)"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (offer)"},{"v":"off","l":"off"},{"v":"auto","l":"auto"}]},
  {"env":"MERCURY_CONCOURSE","label":"Session Concourse at boot","group":"miscellaneous","summary":"where a plain boot LANDS — the Concourse itself stays on either way: Off lands the Boot face · Auto lands the Concourse board when sessions are live or waiting · Always makes the board the boot home","detail":{"controls":"Sets where a boot lands (`--concourse-off` controls whether the Session Concourse is enabled). Off (default): a plain `mercury` launch lands on the Boot face, with the Concourse at shift+← and a face row away; a prompt argument or `--continue`/`--resume` goes straight to the chat, leaving existing background sessions untouched. Auto: lands on the Concourse board when more than one session is live or one is waiting on you, otherwise the Boot face. Always: the Concourse board is the boot home. Resolution reads one bounded records summary before the chat mounts, with no daemon call or fleet discovery.","on":["auto: >1 live session or a waiting question boots into the Concourse board","always: every boot lands on the Concourse board (the chat one shift+→ away)","existing sessions are never cancelled, hidden or mutated by any choice"],"off":["plain launches land the Boot face; the Concourse stays on — shift+← from the chat (or its face row) opens the board"]},"defaultFollows":null,"warnWhenOn":null,"choices":[{"v":null,"l":"default (off)"},{"v":"auto","l":"auto"},{"v":"always","l":"always"}]},
]

const MODEL_NAMES = {
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
  "claude-sonnet-4-20250514": "Sonnet 4",
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-4-20250514": "Opus 4",
  "claude-opus-4-1-20250805": "Opus 4.1",
  "claude-opus-4-5-20251101": "Opus 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5": "Opus 5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-fable-5": "Fable 5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-fable-5-2": "Fable 5.2",
  "claude-mythos-5": "Mythos 5",
  "claude-mythos-5-1": "Mythos 5.1",
  "claude-mythos-5-2": "Mythos 5.2",
  "grok-4.7": "Grok 4.7",
  "grok-4.7-build-fast": "Grok 4.7 Fast",
  "grok-4.6": "Grok 4.6",
  "grok-4.5": "Grok 4.5",
  "grok-4.3": "Grok 4.3",
  "grok-4.20-0309-reasoning": "Grok 4.20",
  "grok-4.20-0309-non-reasoning": "Grok 4.20 (Non-Reasoning)",
  "grok-build-0.1": "Grok Build 0.1",
  "muse-spark-1.3": "Muse Spark 1.3",
  "muse-wonder-1.0": "Muse Wonder 1.0",
  "muse-spark-1.2": "Muse Spark 1.2",
  "muse-spark-1.1": "Muse Spark 1.1",
  "muse-ember-1.0": "Muse Ember 1.0",
  "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor (training permitted)",
  "muse-spark-1.2-contributor": "Muse Spark 1.2 Contributor (training permitted)",
  "muse": "Muse",
  "mistral-large-4": "Mistral Large 4 (Le Chonk)",
  "mistral-large-4-0": "Mistral Large 4 (Le Chonk)",
  "mistral-large-latest": "Mistral Large 4 (Le Chonk)",
  "mistral-medium-3-5": "Mistral Medium 3.5",
  "mistral-medium-latest": "Mistral Medium 3.5",
  "mistral-medium-3": "Mistral Medium 3.5",
  "mistral-small-2603": "Mistral Small 4",
  "mistral-small-latest": "Mistral Small 4",
  "mistral-large-2512": "Mistral Large 3",
  "ministral-14b-2512": "Ministral 3 14B",
  "ministral-14b-latest": "Ministral 3 14B",
  "ministral-8b-2512": "Ministral 3 8B",
  "ministral-8b-latest": "Ministral 3 8B",
  "ministral-3b-2512": "Ministral 3 3B",
  "ministral-3b-latest": "Ministral 3 3B",
  "codestral-2508": "Codestral",
  "codestral-latest": "Codestral",
  "zai-glm-5-3": "Z.ai GLM 5.3",
  "zai-glm-5-3-flash": "Z.ai GLM 5.3 Flash",
  "deepseek-v4-1-flash-1017": "DeepSeek V4.1 Flash 1017",
  "mistral": "Mistral",
  "minimax-m3": "MiniMax M3",
  "minimax-m3.1-flash": "MiniMax M3.1 Flash",
  "minimax-m3.1-flash-preview": "MiniMax M3.1 Flash (preview, M Plan)",
  "minimax-m2.7": "MiniMax M2.7",
  "minimax-m2.7-highspeed": "MiniMax M2.7 Highspeed",
  "minimax-m2.5": "MiniMax M2.5",
  "minimax-m2.5-highspeed": "MiniMax M2.5 Highspeed",
  "minimax": "MiniMax",
  "command-a-plus-05-2026": "Command A+",
  "north-mini-code-1-0": "North Mini Code 1.0",
  "command-a-reasoning-08-2025": "Command A Reasoning",
  "command-a-03-2025": "Command A",
  "command-a-vision-07-2025": "Command A Vision",
  "command-r-plus-08-2024": "Command R+",
  "command-r-08-2024": "Command R",
  "command-r7b-12-2024": "Command R7B",
  "c4ai-aya-expanse-32b": "Aya Expanse 32B",
  "tiny-aya-global": "Tiny Aya Global",
  "tiny-aya-earth": "Tiny Aya Earth",
  "tiny-aya-fire": "Tiny Aya Fire",
  "tiny-aya-water": "Tiny Aya Water",
  "command-a-translate-08-2025": "Command A Translate",
  "north-small-translate-09-2026": "North Small Translate",
  "cohere": "Cohere",
  "groq/openai/gpt-oss-120b": "GPT OSS 120B",
  "groq/openai/gpt-oss-20b": "GPT OSS 20B",
  "groq/qwen/qwen3.8-27b": "Qwen 3.8 27B",
  "groq/minimaxai/minimax-m2.7": "MiniMax M2.7",
  "groq/meta-models/muse-spark-open": "Muse Spark Open",
  "groq/llama-3.3-70b-versatile": "Llama 3.3 70B",
  "groq/llama-3.1-8b-instant": "Llama 3.1 8B",
  "cerebras/gpt-oss-120b": "GPT OSS 120B",
  "cerebras/qwen-3.8-27b": "Qwen 3.8 27B",
  "fireworks/accounts/fireworks/models/kimi-k3": "Kimi K3",
  "fireworks/accounts/fireworks/models/ember-1": "Ember-1",
  "fireworks/accounts/fireworks/models/glm-5p3": "GLM 5.3",
  "fireworks/accounts/fireworks/models/glm-5p3-flash": "GLM 5.3 Flash",
  "fireworks/accounts/fireworks/models/deepseek-v4p1-flash": "DeepSeek V4.1 Flash",
  "fireworks/accounts/fireworks/models/qwen3p8-max": "Qwen 3.8 Max",
  "fireworks/accounts/fireworks/models/minimax-m3p1-flash": "MiniMax M3.1 Flash",
  "fireworks/accounts/fireworks/models/minimax-m3": "MiniMax M3",
  "fireworks/accounts/fireworks/models/gpt-oss-120b": "GPT OSS 120B",
  "fireworks/accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b": "Nemotron 3.5 Lightning 30B",
  "fireworks/accounts/fireworks/models/nemotron-3-ultra-nvfp4": "Nemotron 3 Ultra (preview)",
  "fireworks/accounts/fireworks/routers/kimi-fast-latest": "Kimi Fast (Fire Pass)",
  "fireworks/accounts/fireworks/models/muse-spark-open": "Muse Spark Open",
  "fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017": "DeepSeek V4.1 Flash 1017",
  "qwen3.8-max": "Qwen3.8 Max",
  "qwen4-max": "Qwen4 Max",
  "qwen3.7-max": "Qwen3.7 Max",
  "qwen3.7-plus": "Qwen3.7 Plus",
  "qwen3.8-flash": "Qwen3.8 Flash",
  "qwen3.8-omni-flash": "Qwen3.8 Omni Flash",
  "qwen3.7-flash": "Qwen3.7 Flash",
  "qwen3.6-flash": "Qwen3.6 Flash",
  "qwen3-coder-flash": "Qwen3 Coder Flash",
  "qwen-auto": "Auto (the plan picks the model)",
  "qwen": "Qwen",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash-vision-exp": "DeepSeek V4.1 Flash",
  "kimi-k3": "Kimi K3",
  "kimi-k3.1-pro": "Kimi K3.1 Pro",
  "kimi-k3.1-pro-highspeed": "Kimi K3.1 Pro Highspeed",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k2.7-code-highspeed": "Kimi K2.7 Code Highspeed",
  "kimi-k2.6": "Kimi K2.6",
  "k3.1-pro": "K3.1 Pro",
  "k3.1-pro-highspeed": "K3.1 Pro Highspeed",
  "k3": "K3",
  "k3-256k": "K3 256K",
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.2": "GLM-5.2",
  "sonnet": "Sonnet 5.5",
  "opus": "Opus 5.5",
  "haiku": "Haiku 5.5",
  "fable": "Fable 5.2",
  "fable51": "Fable 5.1",
  "fable52": "Fable 5.2",
  "mythos": "Mythos 5.2",
  "best": "Opus 5.5",
  "grok": "Grok 4.7",
  "deepseek": "DeepSeek V4 Pro",
  "kimi": "Kimi K3",
  "glm": "GLM-5.3",
}

const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const RAMP = [[221,68,68],[229,132,132],[232,183,175]]
const RAMP_FIXTURE = [[0,221,68,68,172,59,59],[7,223,85,85,173,68,68],[15,226,105,105,175,78,78],[22,228,122,122,176,86,86],[26,229,132,132,176,91,91],[30,229,140,139,176,95,95],[37,230,154,150,177,102,100],[45,231,169,163,177,110,107],[52,232,183,175,178,117,113]]
const CAPABILITY_TRUTH = [[null,null,null,"xterm-256color","truecolor",null,"truecolor"],["1",null,null,"xterm-256color","truecolor",null,"plain"],["1","1",null,"xterm-256color","truecolor",null,"truecolor"],["",null,null,"xterm-256color","truecolor",null,"truecolor"],["1","",null,"xterm-256color","truecolor",null,"truecolor"],[null,null,"0","xterm-256color","truecolor",null,"256"],[null,null,null,"dumb","truecolor",null,"256"],[null,null,null,"linux","truecolor",null,"256"],["1",null,"0","xterm-256color","truecolor",null,"plain"],[null,null,null,"xterm-256color",null,null,"256"],[null,null,null,"xterm-256color",null,"Apple_Terminal","256"],[null,null,null,"xterm-256color","truecolor","Apple_Terminal","truecolor"],[null,null,null,"xterm-256color","24bit",null,"truecolor"],[null,null,null,"xterm-256color",null,"vscode","truecolor"],[null,null,null,"xterm-256color",null,"iTerm.app","truecolor"],[null,null,null,"xterm-kitty",null,null,"truecolor"],[null,null,"1","xterm-256color",null,null,"truecolor"],[null,null,"1","xterm-256color",null,"Apple_Terminal","truecolor"],["1","1",null,"xterm-256color",null,null,"256"],[null,null,"1","linux",null,null,"256"]]
const TRUECOLOR_QUERY = "\u001b7\u001b[48;2;1;2;3m\u001bP$qm\u001b\\\u001b[0m\u001b8"
const TRUECOLOR_ECHO_TRUTH = [["0;48:2::1:2:3m",true],["0;48:2:1:1:2:3m",true],["48:2:1:2:3m",true],["0;48;2;1;2;3m",true],["0;8;30;48:2::1:2:3m",true],["48;2;0;1;2;3m",true],["0m",false],["0;48:5:16m",false],["0;38:2::1:2:3m",false],["0;48:2::1:2:30m",false],["",false]]
export function truecolorFingerprintOf(env) {
  const colorterm = env.COLORTERM
  if (colorterm === 'truecolor' || colorterm === '24bit') return `COLORTERM=${colorterm}`
  if (env.WT_SESSION) return 'WT_SESSION (Windows Terminal)'
  const program = env.TERM_PROGRAM
  if (program === 'vscode' || program === 'iTerm.app' || program === 'WezTerm' || program === 'ghostty') return `TERM_PROGRAM=${program}`
  const term = env.TERM
  if (term === 'xterm-kitty' || term === 'xterm-ghostty' || term === 'wezterm') return `TERM=${term}`
  return env.KITTY_WINDOW_ID ? 'KITTY_WINDOW_ID (kitty)' : null
}
export function truecolorEchoOf(setting) {
  return /(?:^|;)48[:;]2[:;](?:\d*[:;])?1[:;]2[:;]3(?:;|m|$)/.test(setting)
}
export function truecolorAskableOf(env, platform = process.platform) {
  if (platform === 'win32' || env.MERCURY_SPLASH_ONESHOT === '1') return false
  const fc = env.FORCE_COLOR
  if (Boolean(env.NO_COLOR) && (fc === undefined || !['', '1', '2', '3', 'true'].includes(fc))) return false
  if (fc !== undefined || env.TMUX || env.TERM_PROGRAM === 'Apple_Terminal' || env.MERCURY_TRUECOLOR !== undefined) return false
  if (truecolorFingerprintOf(env) !== null) return false
  const term = env.TERM
  return term !== undefined && term !== 'dumb' && term !== 'linux'
}
const rampSample = u => {
  const s = Math.min(1, Math.max(0, u)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(s))
  return mixc(RAMP[i], RAMP[i + 1], s - i)
}

const ACCENT_FAMILIES = {
  crab: { main: [221,68,68], deep: [123,50,50], soft: [229,132,132], ramp: [[221,68,68],[229,132,132],[232,183,175]], t256: 167, t256deep: 88, t256mid: 124, wordR256: [167,167,167,167,167,167,167,167,167,167,167,167,167,167,167,167,167,167,167,167,174,174,174,174,174,174,174,174,174,174,174,174,174,174,174,174,174,174,174,181,181,181,181,181,181,181,181,181,181,181,181,181,181], wordD256: [124,124,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,131,138] },
  octopus: { main: [176,123,224], deep: [110,75,160], soft: [200,167,223], ramp: [[176,123,224],[200,167,223],[219,199,222]], t256: 140, t256deep: 61, t256mid: 97, wordR256: [140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,183,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,182,252,252,252], wordD256: [97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,97,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,140,139,139,139,139,139,139,139,139,139,139,139] },
  jellyfish: { main: [111,199,232], deep: [63,126,150], soft: [161,212,228], ramp: [[111,199,232],[161,212,228],[199,222,224]], t256: 81, t256deep: 31, t256mid: 74, wordR256: [81,81,81,81,117,117,117,117,117,117,117,117,117,117,117,117,117,117,117,116,116,116,116,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,152,188,253], wordD256: [74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,74,73,73,73,73,73,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109,109] },
  clam: { main: [22,216,176], deep: [14,147,119], soft: [108,222,194], ramp: [[22,216,176],[108,222,194],[173,227,208]], t256: 43, t256deep: 29, t256mid: 36, wordR256: [43,43,43,43,43,43,43,43,43,43,43,43,43,79,79,79,79,79,79,79,79,79,79,79,79,79,79,79,115,115,115,115,115,115,115,115,115,115,115,115,115,115,116,116,116,116,116,151,152,152,152,152,152], wordD256: [36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72,72] },
}
const DEFAULT_CRITTER = "crab"

export function accentFamilyKeyOf(raw) {
  const k = String(raw ?? '').trim().toLowerCase()
  if (Object.hasOwn(ACCENT_FAMILIES, k)) return k
  return DEFAULT_CRITTER
}

const GLOW = {
  TICK_MS: 80,
  GREETING_MS: 2_700,
  EASE_IN_MS: 350,
  EASE_OUT_MS: 600,
  LIFT: 0.45,
  GAIN_LEVELS: 5,
}
const glowRadius = span => Math.max(3, Math.min(8, Math.round(span * 0.28)))
const glowEnvelope = t => {
  if (t <= 0 || t >= GLOW.GREETING_MS) return 0
  const outStart = GLOW.GREETING_MS - GLOW.EASE_OUT_MS
  if (t < GLOW.EASE_IN_MS) { const x = t / GLOW.EASE_IN_MS; return x * x }
  if (t > outStart) { const x = (GLOW.GREETING_MS - t) / GLOW.EASE_OUT_MS; return x * x }
  return 1
}
const glowPeakAt = (t, span) => {
  if (span <= 1) return 0
  const u = Math.min(1, Math.max(0, t / GLOW.GREETING_MS))
  return ((1 - Math.cos(u * Math.PI)) / 2) * (span - 1)
}
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
export function glowBoostAt(cellCenter, phase) {
  if (!phase) return 0
  const d = Math.abs(cellCenter - phase.peakCell)
  if (d >= phase.radiusCells) return 0
  const w = Math.cos((d / phase.radiusCells) * (Math.PI / 2))
  return GLOW.LIFT * (phase.gainLevel / GLOW.GAIN_LEVELS) * w * w
}
export const glowSettled = elapsedMs => elapsedMs >= GLOW.GREETING_MS
export const GLOW_TICK_MS = GLOW.TICK_MS

export const WORD_W = Math.max(...WORD.map(r => r.length))
const CARD_LABEL_W = 23

const SGR_RE = /\x1b\[[0-9;]*m/g
const cpWidth = cp => {
  if (cp === 0x200d) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}
const MARK_RE = /\p{M}/u
const NON_SIMPLE_RE = /[\u0300-\u{10ffff}]/u
const vis = s => {
  const t = s.replace(SGR_RE, '')
  if (!NON_SIMPLE_RE.test(t)) return t.length
  let w = 0
  for (const ch of t) {
    if (MARK_RE.test(ch)) continue
    w += cpWidth(ch.codePointAt(0))
  }
  return w
}

const padVis = (s, w) => s + ' '.repeat(Math.max(0, w - vis(s)))

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

function clipWords(s, w) {
  const text = String(s)
  if (vis(text) <= w) return text
  if (w <= 1) return '…'
  let cut = ''
  let width = 0
  let idx = 0
  for (; idx < text.length; ) {
    const cp = text.codePointAt(idx)
    const ch = String.fromCodePoint(cp)
    const cw = MARK_RE.test(ch) ? 0 : cpWidth(cp)
    if (width + cw > w - 1) break
    cut += ch
    width += cw
    idx += ch.length
  }
  if (idx < text.length && text[idx] === ' ') {
    const head = cut.replace(/[\s·—–\/(-]+$/, '')
    return (head || cut.trimEnd()) + '…'
  }
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > 0) {
    const head = cut.slice(0, lastSpace).replace(/[\s·—–\/(-]+$/, '')
    if (head) return head + '…'
  }
  return cut.trimEnd() + '…'
}

function splitHardVis(word, w) {
  const parts = []
  let cur = ''
  let n = 0
  for (const ch of word) {
    const cw = MARK_RE.test(ch) ? 0 : cpWidth(ch.codePointAt(0))
    if (cur && n + cw > w) {
      parts.push(cur)
      cur = ch
      n = cw
    } else {
      cur += ch
      n += cw
    }
  }
  if (cur) parts.push(cur)
  return parts
}

const endVis = (word, w) => [...splitHardVis([...word].reverse().join(''), w)[0]].reverse().join('')

function wrapDetailLine(raw, maxW, wrapW = maxW) {
  const s = String(raw)
  if (!s || vis(s) <= maxW) return [s]
  const indent = /^ */.exec(s)[0]
  const body = s.slice(indent.length).trim()
  if (!body) return [s.slice(0, maxW)]
  const contIndent = indent.length + 2 < Math.floor(wrapW / 2) ? indent + '  ' : indent
  const words = body.split(/\s+/).filter(Boolean)
  const out = []
  let cur = indent
  let curW = indent.length
  let hasWord = false
  for (const wd of words) {
    const wdW = vis(wd)
    if (hasWord && curW + 1 + wdW > wrapW) {
      out.push(cur)
      cur = contIndent
      curW = contIndent.length
      hasWord = false
    }
    if (!hasWord && curW + wdW > wrapW) {
      const firstAvail = Math.max(1, wrapW - curW)
      const contAvail = Math.max(1, wrapW - contIndent.length)
      let rest = wd
      let lead = cur
      let avail = firstAvail
      while (vis(rest) > avail) {
        const piece = splitHardVis(rest, avail)[0]
        out.push(lead + piece)
        rest = rest.slice(piece.length)
        lead = contIndent
        avail = contAvail
      }
      cur = lead + rest
      curW = vis(cur)
      hasWord = rest.length > 0
      continue
    }
    cur += (hasWord ? ' ' : '') + wd
    curW += (hasWord ? 1 : 0) + wdW
    hasWord = true
  }
  if (hasWord) out.push(cur)
  return out
}

function zipCols(a, b, aW, gap) {
  const n = Math.max(a.length, b.length)
  const outL = []
  for (let i = 0; i < n; i++) {
    outL.push(padVis(a[i] ?? '', aW) + ' '.repeat(gap) + (b[i] ?? ''))
  }
  return outL
}

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
  rows.push({
    key: 'new',
    label: 'New Session',
    ctx: 'start fresh here',
  })
  if (facts.continueTarget) {
    const ct = facts.continueTarget
    rows.push({
      key: 'continue',
      label: 'Continue Last Session',
      ctx: ct.cross ? `in ${ct.base}` : `${ct.base} · ${fmtAge(ct.ageMs)}`,
      ...(ct.dim ? { dim: true } : {}),
    })
  }
  if (facts.menuAvailable) {
    rows.push({ key: 'logins', label: 'Logins/Keys', ctx: facts.loginsCtx ?? 'sign in to providers' })
  }
  if (facts.concourse) {
    rows.push({
      key: 'concourse',
      label: 'Session Manager (Concourse)',
      ctx: facts.concourse.ctx,
      ...(facts.concourse.dim ? { dim: true } : {}),
    })
  }
  if (facts.menuAvailable) rows.push({ key: 'menu', label: 'Boot Menu', ctx: 'configure boot env' })
  return rows
}

export function withProfilesRow(rows, boxed) {
  if (rows[rows.length - 1]?.key !== 'menu') return rows
  const more = [...rows, { key: 'profiles', label: 'Profiles', ctx: 'separate logins and history' }]
  return boxed(more) ? more : rows
}

export function bootMenuMicro(cols, rowsAvail) {
  return rowsAvail < 10 || cols < 48
}

export function bootMenuAsks(cols, rowsAvail, asking) {
  return rowsAvail >= 2 && vis(asking) <= cols
}

function placeBlock(block, rows) {
  const pad = rows - block.length
  if (pad <= 0) return { placed: block, top: 0 }
  const top = Math.max(0, Math.round(pad * 0.42))
  return { placed: [...Array(top).fill(''), ...block], top }
}

export function emitCells(cells) {
  const final = new Map()
  for (const c of cells) final.set(c.y * 65536 + c.x, c)
  const order = [...final.values()].sort((a, b) =>
    a.sgr < b.sgr ? -1 : a.sgr > b.sgr ? 1 : a.y - b.y || a.x - b.x,
  )
  let out = ''
  let sgr = ''
  let x = -1
  let y = -1
  for (const c of order) {
    if (c.sgr !== sgr) {
      out += c.sgr
      sgr = c.sgr
    }
    if (c.y !== y) out += `\x1b[${c.y + 1};${c.x + 1}H`
    else if (c.x !== x) out += `\x1b[${c.x + 1}G`
    out += c.ch
    x = c.x + 1
    y = c.y
  }
  return sgr === '' ? out : out + '\x1b[0m'
}

export function createSplashCore({ nocolor = false, truecolor = true, accent } = {}) {
  const NOCOLOR = !!nocolor
  const TRUECOLOR = !NOCOLOR && !!truecolor
  const ACC =
    accent && typeof accent === 'object'
      ? accent
      : ACCENT_FAMILIES[accentFamilyKeyOf(accent ?? 'crab')] ?? ACCENT_FAMILIES.crab
  const ACC_MID = mixc(ACC.deep, ACC.main, 0.5)
  const ACC_HEX = '#' + ACC.main.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()

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
const BY256 = new Map([
  [CREAM.join(), T256.cream], [MIDCREAM.join(), T256.dim], [RED.join(), T256.red],
  [DEEPRED.join(), T256.dimred], [MIDRED.join(), T256.midred], [DUNE.join(), T256.dune],
  [TEALC.join(), T256.teal], [AMBERC.join(), T256.amber], [CRIMSONC.join(), T256.crimson],
  [GROUND_FAMILIES.dark.join(), T256.dark], [GROUND_FAMILIES['true-black'].join(), T256.black],
  [ACC.main.join(), ACC.t256], [ACC.deep.join(), ACC.t256deep], [ACC_MID.join(), ACC.t256mid ?? ACC.t256],
])
const code256Of = px => (typeof px === 'number' ? px : BY256.get(px.join()) ?? T256.dim)
function paint(px) { return NOCOLOR ? '' : TRUECOLOR ? rgbFg(px) : `\x1b[38;5;${code256Of(px)}m` }
function paintBg(px) { return NOCOLOR ? '' : TRUECOLOR ? rgbBg(px) : `\x1b[48;5;${code256Of(px)}m` }
const PXA = { E: CREAM, e: MIDCREAM, R: ACC.main, r: ACC.deep, d: ACC_MID }

function rasterHard(grid, toneAt) {
  const H = grid.length
  const W = Math.max(...grid.map(r => r.length))
  const g = grid.map(r => r.padEnd(W, '.'))
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
      else if (!NOCOLOR) { sgr = paint(px(b, x)) + paintBg(px(t, x)); cell = '▄' }
      else { sgr = paint(px(t, x)) + paintBg(px(b, x)); cell = '▀' }
      if (sgr !== run) { line += R + sgr; run = sgr }
      line += cell
    }
    lines.push(line + R)
  }
  return { lines, width: W }
}

const accentFg = () => hexFg(ACC_HEX, ACC.t256)

function dividerLine(width) {
  const total = 16 + 2 * Math.max(2, Math.floor((width - 20) / 2))
  return accentFg() + '─'.repeat(total) + R
}

const sampleFace = u => {
  const s = Math.min(1, Math.max(0, u)) * (ACC.ramp.length - 1)
  const i = Math.min(ACC.ramp.length - 2, Math.floor(s))
  return mixc(ACC.ramp[i], ACC.ramp[i + 1], s - i)
}

const wordTone = (ch, x, W, phase = null) => {
  if (ch !== 'R' && ch !== 'd') return PXA[ch]
  if (!TRUECOLOR) {
    if (NOCOLOR) return PXA[ch]
    const tbl = ch === 'R' ? ACC.wordR256 : ACC.wordD256
    return tbl ? tbl[W === tbl.length ? x : Math.min(tbl.length - 1, Math.max(0, Math.round((x / Math.max(1, W - 1)) * (tbl.length - 1))))] : ch === 'R' ? ACC.t256 : ACC.t256deep
  }
  let u = x / (W - 1)
  const boost = glowBoostAt(x, phase)
  if (boost > 0) u = u + boost * (1 - u)
  const face = sampleFace(u)
  return ch === 'R' ? face : mixc(ACC.deep, face, 0.5)
}
const wordToneGlow = phase => (ch, x, W) => wordTone(ch, x, W, phase)
function rampLabel(text) {
  if (NOCOLOR) return text
  let out = ''
  let run = null
  for (let i = 0; i < text.length; i++) {
    const u = (i + 0.5) / text.length
    const sgr = TRUECOLOR ? rgbFg(sampleFace(u)) : `\x1b[38;5;${ACC.wordR256 ? ACC.wordR256[Math.min(ACC.wordR256.length - 1, Math.max(0, Math.round(u * (ACC.wordR256.length - 1))))] : ACC.t256}m`
    if (sgr !== run) { out += sgr; run = sgr }
    out += text[i]
  }
  return out
}
const PLATE_TONE = VOID
const onPlate = s => {
  const p = paintBg(PLATE_TONE)
  return p ? p + s.replaceAll(R, R + p) + R : s + R
}
const boxTop = (w, bc) => onPlate(bc + '╭' + '─'.repeat(w) + '╮')
const boxBot = (w, bc) => onPlate(bc + '╰' + '─'.repeat(w) + '╯')
const boxSep = (w, bc) => onPlate(bc + '├' + '─'.repeat(w) + '┤')
const boxRow = (content, w, bc) => onPlate(bc + '│' + R + padVis(content, w) + bc + '│')

function clipVis(s, w) {
  if (vis(s) <= w) return s
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

const HINT_GAP = '     '
const COMPACT_HINT_GAP = '   '

function composeHint(segments, withCard) {
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const faint = hexFg(FAINT, T256.faint)
  let s = red + '>_' + R
  for (const seg of segments) {
    s += HINT_GAP + red + seg.key + R + (seg.tone === 'ivory' ? ivory : faint) + seg.label + R
  }
  if (withCard) s += HINT_GAP + red + '↑↓' + R
  return s
}

function composeCard(rows, selIdx, w, seps = true) {
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
    const caret = sel ? red + '❯ ' + R : '  '
    const label = (sel ? BOLD + rampLabel(r2.label.padEnd(labelW)) : (r2.dim ? hexFg(FAINT, T256.faint) : paint(MIDCREAM)) + r2.label.padEnd(labelW)) + R
    const left = ' ' + caret + label
    const arrow = r2.dim ? ' ' : (sel ? red : faint) + '→' + R
    const ctxBudget = inner - vis(left) - 4
    let ctx = r2.ctx
    if (vis(ctx) > ctxBudget) ctx = ctxBudget > 1 ? clipVis(ctx, ctxBudget) : '…'
    const gap = Math.max(0, inner - vis(left) - vis(ctx) - 3)
    rowLines.push(lines.length)
    lines.push(boxRow(r2.ctx ? left + ' '.repeat(gap) + faint + ctx + R + ' ' + arrow + ' ' : left, inner, bc))
    if (seps && i < rows.length - 1) lines.push(boxSep(inner, bc))
  })
  lines.push(boxBot(inner, bc))
  return { lines, rowLines }
}

function composeStrip(chips, w) {
  const faint = hexFg(FAINT, T256.faint)
  const ivory = hexFg(IVORY, T256.cream)
  const budget = Math.max(2, w - 16)
  const model = clipVis(chips.model, Math.max(1, budget - Math.min(vis(chips.dir), Math.floor(budget / 2))))
  const dir = clipVis(chips.dir, Math.max(1, budget - vis(model)))
  const line = faint + 'Model ' + R + accentFg() + model + R + '   ' + faint + 'Dir: ' + R + ivory + dir + R
  return [clipVis(line, w)]
}

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

const MENU_FLOOR_COLS = 64
const MENU_FLOOR_ROWS = 13
const menuBelowFloor = (cols, rowsAvail) => cols < MENU_FLOOR_COLS || rowsAvail < MENU_FLOOR_ROWS
const menuWantsLine = (cols, rowsAvail) =>
  `wants at least ${MENU_FLOOR_COLS}×${MENU_FLOOR_ROWS} · this window is ${cols}×${rowsAvail}`

function composeBootMenu(cols, rowsAvail, m) {
  if (bootMenuMicro(cols, rowsAvail)) return composeBootMenuMicro(cols, rowsAvail, m)
  if (cols >= 110 && !menuBelowFloor(cols, rowsAvail)) {
    for (const withHead of [true, false]) {
      const w = composeBootMenuWide(cols, rowsAvail, m, withHead)
      if (w && w.lines.length <= rowsAvail) return w
    }
  }
  return composeBootMenuClassic(cols, rowsAvail, m)
}

function composeBootMenuMicro(cols, rowsAvail, m) {
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const mid = paint(MIDCREAM)
  const clip = s => (vis(s) <= cols ? s : clipVis(s, cols))
  const rows = Math.max(1, rowsAvail)
  if (rows === 1) {
    const full = red + '(>_) ' + ivory + 'menu' + R + faint + ' · esc back · ↵ cycles' + R
    const noCycle = red + '(>_) ' + ivory + 'menu' + R + faint + ' · esc back' + R
    const exitOnly = faint + 'esc back' + R
    const line = m.legendMicro === undefined && vis(full) <= cols ? full : vis(noCycle) <= cols ? noCycle : clip(exitOnly)
    return { lines: [line], entryLines: [] }
  }
  const lines = []
  const entryLines = []
  lines.push(clip(red + '(>_) ' + ivory + (m.title ?? 'boot menu') + R + faint + ' · ' + menuWantsLine(cols, rowsAvail) + R))
  const budget = rows - 2
  if (budget >= 1 && m.entries.length > 0) {
    const sel = Math.max(0, Math.min(m.selIdx ?? 0, m.entries.length - 1))
    const start = Math.max(0, Math.min(sel - (budget >> 1), m.entries.length - budget))
    for (let i = start; i < Math.min(m.entries.length, start + budget); i++) {
      const r2 = m.entries[i]
      const isSel = i === sel
      const lead = isSel ? red + '❯ ' + R : '  '
      const rawVal = r2.pinnedVal !== null && r2.pinnedVal !== undefined ? `env=${r2.pinnedVal} wins` : r2.valueLabel
      const labTxt = m.fitLabels ? clipWords(r2.label, Math.max(1, cols - 2 - (rawVal ? Math.min(16, vis(rawVal) + 3) : 0))) : r2.label
      const label = (isSel ? ivory : r2.inert ? faint : mid) + labTxt + R
      const valRem = m.fitLabels ? Math.max(1, cols - 2 - vis(labTxt) - 3) : rawVal.length
      const val = faint + ' · ' + (m.fitLabels ? clipWords(rawVal, valRem) : rawVal) + R
      entryLines.push({ entry: i, line: lines.length })
      lines.push(clip(lead + label + val))
    }
  }
  lines.push(clip(m.asking ? paint(TEALC) + m.asking + R : faint + (m.legendMicro ?? '↑↓ · ↵ cycles · esc back') + R))
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
  const legendLines = vis(m.legend) <= cols ? [m.legend] : wrapWords(m.legend, Math.max(1, cols))

  const cRows = []
  const cRowEntry = []
  let selLine = 0
  let selEnd = 0
  let lastGroup = null
  m.entries.forEach((r2, i) => {
    if (r2.group !== lastGroup) {
      if (lastGroup !== null) { cRows.push(''); cRowEntry.push(-1) }
      cRows.push(' ' + faint + (r2.groupTitle ?? r2.group.toUpperCase()) + R)
      cRowEntry.push(-1)
      lastGroup = r2.group
    }
    const sel = i === m.selIdx
    const pinned = r2.pinnedVal !== null && r2.pinnedVal !== undefined
    const valTxt = pinned ? `env=${r2.pinnedVal} wins` : r2.valueLabel
    const valSGR = pinned || r2.inert ? faint : r2.valueIsDefault ? faint : cream
    const innerW = LEFT_W - 2
    if (m.fitLabels) {
      const rowBudget = innerW - 1
      const labelTxt = clipWords(r2.label, Math.max(1, rowBudget - 3))
      const valShown = valTxt === '' ? '' : clipWords(valTxt, Math.max(1, rowBudget - 3))
      const lab = sel ? red + '❯ ' + R + BOLD_UL + ivory + labelTxt + R : '  ' + (r2.inert ? faint : mid) + labelTxt + R
      if (sel) selLine = cRows.length
      if (valShown === '' || vis(' ' + lab) + 1 + vis(valShown) <= rowBudget) {
        const gap = valShown === '' ? 0 : Math.max(1, rowBudget - vis(' ' + lab) - vis(valShown))
        cRowEntry.push(i)
        cRows.push(valShown === '' ? ' ' + lab : ' ' + lab + ' '.repeat(gap) + valSGR + valShown + R)
      } else {
        cRowEntry.push(i)
        cRows.push(' ' + lab)
        const valPad = Math.max(3, rowBudget - vis(valShown))
        cRowEntry.push(-1)
        cRows.push(' '.repeat(valPad) + valSGR + valShown + R)
      }
    } else {
      const lab = sel ? red + '❯ ' + R + BOLD_UL + ivory + r2.label + R : '  ' + (r2.inert ? faint : mid) + r2.label + R
      const gap = Math.max(1, innerW - vis(' ' + lab) - valTxt.length - 1)
      if (sel) selLine = cRows.length
      cRowEntry.push(i)
      cRows.push(' ' + lab + ' '.repeat(gap) + valSGR + valTxt + R)
    }
    if (r2.warn) {
      cRowEntry.push(-1)
      cRows.push(' ' + paint(AMBERC) + '▲ ' + r2.warn + R)
    }
    if (sel) selEnd = cRows.length - 1
  })
  const wordH = rasterHard(WORD).lines.length
  const headH = withHead ? 1 + rasterHard(HEADSTD).lines.length : 0
  const leftInteriorBudget = Math.max(9, rowsAvail - headH - wordH - 8 - 2 - Math.max(0, legendLines.length - 1))
  let cShown = cRows
  let cShownEntry = cRowEntry
  if (cRows.length > leftInteriorBudget) {
    let start = 0
    let end = leftInteriorBudget - 1
    if (selEnd < leftInteriorBudget - 1) {
      start = 0
      end = leftInteriorBudget - 1
    } else if (selLine >= cRows.length - (leftInteriorBudget - 1)) {
      end = cRows.length
      start = cRows.length - (leftInteriorBudget - 1)
    } else {
      const visRows = leftInteriorBudget - 2
      const lo = Math.max(1, selEnd - visRows + 1)
      const hi = Math.min(selLine, cRows.length - visRows - 1)
      start = Math.max(lo, Math.min(selLine - (visRows >> 1), hi))
      end = start + visRows
    }
    cShown = [
      ...(start > 0 ? [' ' + faint + `… ${start} more above` + R] : []),
      ...cRows.slice(start, end),
      ...(end < cRows.length ? [' ' + faint + `… ${cRows.length - end} more below` + R] : []),
    ]
    cShownEntry = [
      ...(start > 0 ? [-1] : []),
      ...cRowEntry.slice(start, end),
      ...(end < cRows.length ? [-1] : []),
    ]
  }
  const bc = paint(DUNE)
  const leftInner = LEFT_W - 2
  const leftPanel = [
    boxTop(leftInner, bc),
    ...cShown.map(l => boxRow(clipVis(l, leftInner - 1), leftInner, bc)),
    boxBot(leftInner, bc),
  ]

  const textW = RIGHT_W - 5
  const detailLineW = RIGHT_W - 4
  const fixedRow = fixed => ({ fixed })
  const wrapRow = (raw, style) => ({ raw, style })
  const buildDetailItems = r2 => {
    const d2 = r2.detail || null
    const pinned2 = r2.pinnedVal !== null && r2.pinnedVal !== undefined
    const rows2 = []
    rows2.push(fixedRow(' ' + BOLD + ivory + r2.label + R))
    rows2.push(fixedRow(''))
    rows2.push(fixedRow(' ' + red + 'What it controls' + R))
    for (const l of wrapWords(d2 ? d2.controls : r2.summary, textW)) rows2.push(fixedRow(' ' + mid + l + R))
    const isBootMenu = !m.title || m.title === 'boot menu'
    const extra2 = r2.detailExtra ?? []
    if (!isBootMenu || pinned2 || extra2.length > 0) {
      rows2.push(fixedRow(''))
      rows2.push(fixedRow(' ' + red + 'Current value' + R))
      rows2.push(
        fixedRow(' ' + cream + r2.valueLabel + R + (pinned2 ? faint + ` · env=${r2.pinnedVal} wins` + R : '')),
      )
      for (const raw of extra2) {
        rows2.push(wrapRow(raw, l => ' ' + faint + l + R))
      }
    }
    if (d2) {
      rows2.push(fixedRow(''))
      rows2.push(fixedRow(' ' + red + 'When on' + R))
      for (const b of d2.on)
        wrapWords(b, textW - 2).forEach((l, j) =>
          rows2.push(fixedRow(' ' + faint + (j === 0 ? '◦ ' : '  ') + R + mid + l + R)),
        )
      rows2.push(fixedRow(''))
      rows2.push(fixedRow(' ' + red + 'When off' + R))
      for (const b of d2.off)
        wrapWords(b, textW - 2).forEach((l, j) =>
          rows2.push(fixedRow(' ' + faint + (j === 0 ? '◦ ' : '  ') + R + mid + l + R)),
        )
    }
    return rows2
  }
  const detailHead = row ? (m.fitLabels ? clipWords(row.detailLabel ?? row.label, RIGHT_W - 6) : row.label) : ''
  const dItems = m.detailOverride
    ? [
        ...(detailHead ? [fixedRow(' ' + BOLD + ivory + detailHead + R), fixedRow('')] : []),
        ...m.detailOverride.map(raw => wrapRow(raw, l => ' ' + mid + l + R)),
      ]
    : row
      ? buildDetailItems(row)
      : []

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
        kv('Saved', m.summary.profile),
        kv('Harness', m.summary.harness),
      ]
  const summaryBlock = sRows.length > 0 ? ['', ...sRows] : []

  const dirBudget = RIGHT_W - 2 - 1 - 1 - 11
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
    kv('Critter', m.environment.critter, m.environment.critterHue ? hexFg(m.environment.critterHue, ACC.t256) : accentFg()),
    kv('Dir', '', undefined) + ivory + dirBase + R + faint + dirTail + R,
  ]
  const envBlock = ['', ...eRows]

  const expandDetailRows = items =>
    items.map(item =>
      item.fixed !== undefined
        ? [item.fixed]
        : wrapDetailLine(item.raw, detailLineW, textW).map(l => item.style(l)),
    )
  const dLines = expandDetailRows(dItems)
  const dRows = dLines.flat()
  const word = rasterHard(WORD, wordToneGlow(m.glowWord ?? null))
  const headLines = withHead ? rasterHard(HEADSTD).lines : null
  const chromeRows = (headLines ? 1 + headLines.length : 0) + word.lines.length + 8 + Math.max(0, legendLines.length - 1)
  const geometryBudget =
    rowsAvail - chromeRows - summaryBlock.length - envBlock.length
  const neededDetailRows = m.detailOverride
    ? dRows.length
    : Math.max(dRows.length, ...m.entries.map(r2 => expandDetailRows(buildDetailItems(r2)).flat().length))
  if (withHead && (cRows.length > leftInteriorBudget || geometryBudget < neededDetailRows)) return null
  const detailBudget = Math.max(
    8,
    leftPanel.length - summaryBlock.length - envBlock.length,
    geometryBudget,
  )
  let effectiveDetailBudget = detailBudget
  let keepSummary = true
  let keepEnv = true
  if (m.detailOverrideConfirms && dRows.length > effectiveDetailBudget) {
    keepEnv = false
    effectiveDetailBudget += envBlock.length
    if (dRows.length > effectiveDetailBudget) {
      keepSummary = false
      effectiveDetailBudget += summaryBlock.length
    }
  }
  const wholeLines = room => {
    if (m.detailOverrideConfirms) return dRows.slice(0, room)
    const kept = []
    for (const line of dLines) {
      if (kept.length + line.length > room) break
      kept.push(...line)
    }
    return kept
  }
  const hintRaw = m.moreHint ?? '… (the trail continues — taller terminal)'
  const hintLines = wrapDetailLine(hintRaw, detailLineW, textW).map(l => ' ' + faint + l + R)
  const hintShown = hintLines.slice(0, Math.max(1, effectiveDetailBudget))
  const dShown =
    dRows.length > effectiveDetailBudget
      ? [...wholeLines(Math.max(0, effectiveDetailBudget - hintShown.length)), ...hintShown]
      : dRows
  const dPadded = [...dShown, ...Array(Math.max(0, effectiveDetailBudget - dShown.length)).fill('')]

  const lines = []
  if (headLines) lines.push('', ...headLines)
  lines.push('', dividerLine(word.width), '', ...word.lines, '')
  lines.push(faint + (m.title ?? 'boot menu') + R)
  lines.push('')
  const zipStart = lines.length
  const rightCol = [
    ...dPadded,
    ...(keepSummary ? summaryBlock : []),
    ...(keepEnv ? envBlock : []),
  ].map(l => clipVis(l, RIGHT_W - 1))
  const totalW = LEFT_W + 2 + RIGHT_W
  lines.push(...zipCols(leftPanel, rightCol, LEFT_W, 2).map(l => padVis(l, totalW)))
  lines.push(padVis(' ' + faint + clipVis(m.statusRight, totalW - 1) + R, totalW))
  const askCut = m.asking && m.detailOverrideConfirms && dRows.length > effectiveDetailBudget
  lines.push(...(askCut ? [paint(TEALC) + clipVis(m.asking, totalW) + R] : legendLines.map(line => faint + line + R)))
  const blockW = Math.max(...lines.map(vis))
  const left = Math.max(0, Math.floor((cols - blockW) / 2))
  const centered = lines.map(l => {
    const w = vis(l)
    const pad = left + (w < blockW ? Math.max(0, Math.floor((blockW - w) / 2)) : 0)
    return ' '.repeat(pad) + l
  })
  const entryLines = []
  cShownEntry.forEach((entryIdx, k) => {
    if (entryIdx >= 0) entryLines.push({ entry: entryIdx, line: zipStart + 1 + k })
  })
  return { lines: centered, entryLines }
}

function composeBootMenuClassic(cols, rowsAvail, m) {
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const maxValRaw = m.fitLabels
    ? Math.max(0, ...m.entries.map(r => (r.pinnedVal !== null && r.pinnedVal !== undefined ? vis(r.valueLabel) + vis(` · env=${r.pinnedVal} wins`) : vis(r.valueLabel))))
    : 0
  const minLabelW = Math.min(36, Math.max(16, Math.floor(cols * 0.45)))
  const valReserve = maxValRaw === 0 ? 0 : Math.min(Math.max(0, cols - 4 - minLabelW), maxValRaw)
  const maxLabelW = Math.max(minLabelW, cols - 4 - valReserve)
  const labels = m.fitLabels ? m.entries.map(r => clipWords(r.label, maxLabelW)) : m.entries.map(r => r.label)
  const LW = Math.max(0, ...labels.map(l => l.length))
  const legend = m.legendClassic ?? m.legend
  const legendLines = vis(legend) <= cols ? [legend] : wrapWords(legend, Math.max(1, cols))
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
    const labelTxt = labels[i]
    const valBudget = Math.max(1, cols - 2 - LW - 2)
    const valShown = m.fitLabels && row.valueLabel ? clipWords(row.valueLabel, valBudget) : row.valueLabel
    let line =
      (sel ? red + '❯ ' + R : '  ') +
      (sel ? BOLD_UL + ivory + labelTxt + R : (row.inert ? faint : paint(MIDCREAM)) + labelTxt + R) +
      ' '.repeat(Math.max(0, LW - labelTxt.length)) +
      '  ' + (row.valueIsDefault ? faint : paint(CREAM)) + valShown + R
    if (pinned) line += faint + ' · env=' + row.pinnedVal + ' wins' + R
    if (sel) selPos = listLines.length
    listEntry.push(i)
    listLines.push(line)
    if (row.warn) {
      listEntry.push(-1)
      listLines.push('  ' + paint(AMBERC) + '▲ ' + row.warn + R)
    }
  })
  const noticeText = m.detailOverride && m.detailOverrideConfirms ? m.detailOverride.filter(Boolean).join(' ') : m.noticeLine
  const noticeW = Math.max(20, cols - 4)
  const noticeRoom = Math.max(1, rowsAvail - 4 - 5)
  const cutToEnd = new Set()
  const noticeOver = endOnly =>
    wrapWords(noticeText, noticeW).flatMap(l => {
      if (vis(l) <= noticeW) return [l]
      if (!endOnly) return splitHardVis(l, noticeW)
      const kept = '…' + endVis(l, noticeW - 1)
      cutToEnd.add(kept)
      return [kept]
    })
  const noticeWhole = noticeText ? noticeOver(false) : []
  const noticeWrapped = noticeWhole.length <= noticeRoom ? noticeWhole : noticeOver(true)
  const noticeBudget = Math.min(noticeWrapped.length, noticeRoom)
  const noticeClipped = noticeBudget < noticeWrapped.length
  const noticeLines = noticeWrapped.slice(0, noticeBudget).map((l, i) => {
    const text = noticeClipped && i === noticeBudget - 1 && !cutToEnd.has(l) ? clipVis(l, Math.max(1, cols - 5)) + '…' : l
    return paint(TEALC) + text + R
  })
  const noticeBlank = noticeLines.length > 0 && rowsAvail - 4 - 5 - noticeBudget >= 1
  const chrome =
    noticeLines.length > 0
      ? 4 + noticeBudget + (noticeBlank ? 1 : 0) + 2
      : 7
  const footLines = m.asking && noticeClipped ? [paint(TEALC) + clipVis(m.asking, cols) + R] : legendLines.map(line => faint + line + R)
  const listBudget = Math.max(5, rowsAvail - chrome - Math.max(0, footLines.length - 1))
  let shownList = listLines
  let shownEntry = listEntry
  if (listLines.length > listBudget) {
    const win = Math.max(3, listBudget - 2)
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
  lines.push(ivory + 'MERCURY' + R + faint + ' · ' + (m.title ?? 'boot menu') + R)
  if (noticeLines.length > 0) {
    lines.push(...noticeLines)
    if (noticeBlank) lines.push('')
  } else {
    lines.push('')
  }
  const listStart = lines.length
  lines.push(...shownList)
  lines.push('')
  const rowsW = cols - 4
  const clamp = s => (m.fitLabels ? clipWords(s, rowsW) : s.length > rowsW ? s.slice(0, rowsW - 1) + '…' : s)
  lines.push(
    faint +
      clamp(
        menuBelowFloor(cols, rowsAvail)
          ? `${m.title ?? 'boot menu'} ${menuWantsLine(cols, rowsAvail)}`
          : m.entries[m.selIdx] ? m.entries[m.selIdx].summary : '',
      ) +
      R,
  )
  lines.push(...footLines)
  const blockW = Math.max(...lines.map(vis))
  const left = Math.max(0, Math.floor((cols - blockW) / 2))
  const legendAt = lines.length - footLines.length
  const centered = lines.map((l, i) => {
    const padded = ' '.repeat(left) + l
    if (i >= legendAt) return padded
    return vis(padded) <= cols ? padded : clipVis(padded, cols)
  })
  const entryLines = []
  shownEntry.forEach((entryIdx, k) => {
    if (entryIdx >= 0) entryLines.push({ entry: entryIdx, line: listStart + k })
  })
  return { lines: centered, entryLines }
}

function composeLockup(cols, rows, opts) {
  const word = rasterHard(WORD, wordToneGlow(opts.glowWord ?? null))
  const std = rasterHard(HEADSTD)

  const fitsHead =
    cols >= Math.max(std.width, word.width) + 2 &&
    rows >= std.lines.length + word.lines.length + 8

  const head = fitsHead ? std : null

  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const faint = hexFg(FAINT, T256.faint)
  const hintFor = withCard => composeHint(opts.hintSegments, withCard && !opts.hintCinematic)
  const blank = ''

  const nCardRows = opts.cardRows.length
  const cardHFull = nCardRows > 0 ? nCardRows + 2 : 0
  const cardHTight = nCardRows > 0 ? nCardRows + 2 : 0
  const strip = opts.stripLines(Math.min(cols - 2, 84))
  const stripHeight = strip.length + 1
  const stackOf = ch => (ch > 0 ? ch + stripHeight + 2 : 0)
  const cardW = Math.min(cols - 2, opts.cardRows.some(r => r.ctx) ? 84 : Math.max(32, ...opts.cardRows.map(r => vis(r.label) + 10)))
  const baseNeed = std.lines.length + word.lines.length + 8
  const cardStack = ch => std.lines.length + word.lines.length + 6 + 1 + ch + stripHeight
  const wantFull =
    head !== null && nCardRows > 0 && cols >= cardW + 2 && rows >= cardStack(cardHFull)
  const wantTight =
    head !== null && !wantFull && nCardRows > 0 && cols >= cardW + 2 && rows >= cardStack(cardHTight)
  const wantBare =
    head !== null && !wantFull && !wantTight && nCardRows > 0 && cols >= cardW + 2 &&
    rows >= baseNeed + cardHTight + 1
  const hlCardW = cardW
  const wordBase = word.lines.length + 8
  const hlColsOk = nCardRows > 0 && cols >= hlCardW + 2 && cols >= word.width + 4
  const headStackFits = wantFull || wantTight || wantBare
  const hlFull = !headStackFits && hlColsOk && rows >= wordBase + stackOf(cardHFull)
  const hlTight = !headStackFits && !hlFull && hlColsOk && rows >= wordBase + stackOf(cardHTight)
  const hlBare =
    !headStackFits && !hlFull && !hlTight && hlColsOk && rows >= wordBase + cardHTight + 1
  const headlessCard = hlFull || hlTight || hlBare
  const wordCentre = Math.floor(word.lines.length / 2)
  let block
  let wordRow
  let cardShown
  let cardAt = -1
  let cardIdx = []
  if (head && (headStackFits || !headlessCard)) {
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
      const card = composeCard(opts.cardRows, opts.cardSel, cardW, false)
      block.push(blank)
      cardAt = block.length
      cardIdx = card.rowLines
      block.push(...card.lines)
      if (!wantBare) block.push(blank, ...strip)
    }
    wordRow = head.lines.length + 4 + wordCentre
  } else if (headlessCard) {
    cardShown = true
    const card = composeCard(opts.cardRows, opts.cardSel, hlCardW, false)
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
    if (!hlBare) block.push(blank, ...strip)
    wordRow = 3 + wordCentre
  } else if (rows >= 11 && cols >= word.width + 4) {
    cardShown = false
    block = [blank, dividerLine(word.width + 2), blank, ...word.lines, blank, hintFor(false)]
    if (nCardRows > 0) {
      const cardFloor = wordBase + cardHTight + 1
      const cutFull = faint + `the ${nCardRows}-row card needs ${cardFloor} rows — this window is ${cols}×${rows}` + R
      const cutShort = faint + `card hidden — needs ${cardFloor} rows` + R
      if (vis(cutFull) <= cols) block.push(blank, cutFull)
      else if (vis(cutShort) <= cols) block.push(blank, cutShort)
    }
    wordRow = 3 + wordCentre
  } else {
    cardShown = false
    const tinyFull = red + '(>_) ' + ivory + 'MERCURY' + R + '  ' + faint + opts.tinyHint + R
    const tinyWord = red + '(>_) ' + ivory + 'MERCURY' + R
    const tinyMark = red + '(>_)' + R
    block = [vis(tinyFull) <= cols ? tinyFull : vis(tinyWord) <= cols ? tinyWord : tinyMark]
    wordRow = 0
  }

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

const COMPACT_FRAME_INNER = 62

function compactScrollWindow(n, sel, slots) {
  if (n <= slots) return { start: 0, count: n, above: 0, below: 0 }
  const s = Math.max(0, Math.min(n - 1, sel))
  if (slots <= 2) {
    const count = Math.max(1, slots)
    const start = Math.min(Math.max(0, s - count + 1), n - count)
    return { start, count, above: 0, below: 0 }
  }
  let count = slots - 1
  if (s < count) return { start: 0, count, above: 0, below: n - count }
  if (s >= n - count) return { start: n - count, count, above: n - count, below: 0 }
  count = slots - 2
  const start = Math.min(Math.max(1, s - count + 1), n - count - 1)
  return { start, count, above: start, below: n - start - count }
}

function composeCompactFace(cols, rows, opts) {
  const faint = hexFg(FAINT, T256.faint)
  const red = accentFg()
  const ivory = hexFg(IVORY, T256.cream)
  const bc = paint(DUNE)
  const pointer = opts.pointer ?? '❯'
  const cardRows = opts.cardRows
  const n = cardRows.length
  const sel = opts.cardSel
  const keyMap = opts.keyMap ?? ''
  const keyRows = rows > 2 && (keyMap !== '' || opts.reserveKeyMap === true) ? 1 : 0
  const strip = opts.stripLines?.(Math.max(1, cols - 2)) ?? []
  const showStrip = strip.length > 0 && rows - keyRows >= strip.length + 4
  const avail = Math.max(1, rows - keyRows - (showStrip ? strip.length + 1 : 0))
  const hintRows = avail >= 2 && opts.hintSegments.length > 0 ? 1 : 0
  const word = rasterHard(WORD, wordToneGlow(opts.glowWord ?? null))
  const rule = dividerLine(word.width - 2)
  const textOf = (r, withCtx) => r.label + (withCtx && r.ctx !== '' ? ' · ' + r.ctx : '')
  const widest = withCtx => Math.max(0, ...cardRows.map(r => 3 + vis(textOf(r, withCtx))))
  const withCtx = widest(true) + 1 <= cols - 2
  const inner = Math.min(cols - 2, Math.max(cardRows.some(r => r.ctx) ? COMPACT_FRAME_INNER : 34, widest(withCtx) + 5))
  const frameByWidth = widest(withCtx) + 1 <= inner
  const frame = frameByWidth && 2 + n + hintRows <= avail
  const banner = cols >= word.width && 5 + (frame ? 2 : 0) + n + hintRows <= avail
  const slots = frame ? n : Math.max(1, avail - hintRows)
  const win = compactScrollWindow(n, sel, slots)
  const paintRow = (r, i) => {
    const selected = i === sel
    const gutter = ' ' + (selected ? red + pointer + R : ' ') + ' '
    const label = selected
      ? BOLD + rampLabel(r.label) + R
      : (r.dim ? faint : paint(MIDCREAM)) + r.label + R
    const ctx = withCtx && r.ctx !== '' ? faint + ' · ' + r.ctx + R : ''
    return gutter + label + ctx
  }
  const cut = (arrow, k) => '   ' + faint + arrow + ' ' + k + ' more' + R
  const list = []
  if (win.above > 0) list.push({ line: cut('↑', win.above), index: null })
  for (let i = win.start; i < win.start + win.count; i++) list.push({ line: paintRow(cardRows[i], i), index: i })
  if (win.below > 0) list.push({ line: cut('↓', win.below), index: null })
  const hint = opts.hintSegments
    .map(seg => red + seg.key + R + (seg.tone === 'ivory' ? ivory : faint) + seg.label + R)
    .join(COMPACT_HINT_GAP)
  const centre = (line, width) => ' '.repeat(Math.max(0, Math.floor((cols - width) / 2))) + line
  const block = []
  const actions = []
  let wordRow = null
  if (banner) {
    wordRow = block.length + Math.floor(word.lines.length / 2)
    for (const l of word.lines) block.push(centre(l, word.width))
    block.push(centre(rule, vis(rule)))
    block.push('')
  }
  const cardAt = block.length
  if (frame) {
    const pad = ' '.repeat(Math.max(0, Math.floor((cols - inner - 2) / 2)))
    block.push(pad + boxTop(inner, bc))
    for (const entry of list) {
      if (entry.index !== null) actions.push({ line: block.length, index: entry.index })
      block.push(pad + boxRow(clipVis(entry.line, inner - 1), inner, bc))
    }
    if (hintRows) block.push(pad + boxRow(' ' + hint, inner, bc))
    block.push(pad + boxBot(inner, bc))
  } else {
    const bare = list.map(entry => clipVis(entry.line, cols))
    const bareHint = hintRows ? clipVis(hint, cols) : null
    const width = Math.max(0, ...bare.map(vis), bareHint === null ? 0 : vis(bareHint))
    const pad = ' '.repeat(Math.max(0, Math.floor((cols - width) / 2)))
    list.forEach((entry, k) => {
      if (entry.index !== null) actions.push({ line: block.length, index: entry.index })
      block.push(pad + bare[k])
    })
    if (bareHint !== null) block.push(pad + bareHint)
  }
  if (showStrip) block.push('', ...strip.map(l => centre(l, vis(l))))
  const { placed, top } = placeBlock(block, rows - keyRows)
  const lines = placed.slice(0, rows)
  while (lines.length < rows) lines.push('')
  if (keyRows && keyMap !== '') {
    const shown = vis(keyMap) + 2 <= cols ? keyMap : clipVis(keyMap, cols)
    lines[rows - 1] = ' '.repeat(Math.max(0, cols - vis(shown) - 2)) + faint + shown + R
  }
  const signs = red + '>_' + R + HINT_GAP + red + '↵' + R
  const tiny = red + '(>_) ' + ivory + 'MERCURY' + R + '  ' + red + '↵' + R
  const heroLine = banner || vis(tiny) > cols ? signs : tiny
  const hero = placed.slice(0, top + cardAt)
  hero.push(centre(heroLine, vis(heroLine)))
  return {
    lines,
    actions: actions.map(a => ({ line: a.line + top, index: a.index })),
    hero,
    wordRow: wordRow === null ? null : wordRow + top,
    top,
    framed: frame,
  }
}

  return {
    R, BOLD, BOLD_UL, DIM,
    rgbFg, rgbBg, hexFg, paint, paintBg,
    rasterHard, dividerLine, wordTone, wordToneGlow, rampLabel, rampSample, sampleFace,
    boxTop, boxBot, boxSep, boxRow, clipVis,
    composeHint, composeCard, composeStrip, composeProjects, composeLockup, composeCompactFace, placeBlock,
    composeBootMenu, composeBootMenuWide, composeBootMenuClassic,
    vis, cpWidth, MARK_RE, padVis, wrapWords, zipCols, mixc,
    T256, CREAM, RED, VOID, FAINT, IVORY, MIDCREAM, DEEPRED, MIDRED, DUNE, PX,
    TEALC, AMBERC, CRIMSONC,
    ACCENT: ACC, ACCENT_HEX: ACC_HEX, accentFg,
  }
}

export { HEADSTD, WORD, MENU, MODEL_NAMES, RAMP, RAMP_FIXTURE, CAPABILITY_TRUTH, TRUECOLOR_QUERY, TRUECOLOR_ECHO_TRUTH, ACCENT_FAMILIES, DEFAULT_CRITTER, vis, cpWidth, MARK_RE, padVis, wrapWords, zipCols, placeBlock, mixc, rampSample }
