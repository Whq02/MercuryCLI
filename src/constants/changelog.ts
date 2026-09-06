
export const MERCURY_CHANGELOG = `# Mercury changelog

## 1.0.0-beta.3
- GPT-6 Astra is a first-class model: it appears once a connected OpenAI account serves it, effort reaches max, and every turn is priced at the published rate
- GPT-5.6 models are priced at the current published rates, including the long-context tier
- Effort has a sixth level, ultra, wherever the account serves it; a level the provider refuses is remembered, the nearest served level runs, and the transcript says so
- A model switch on a runner that has stopped restarts it on the requested model; an agent paused by a rate limit resumes when the window resets or the session switches model
- Every screen shows the model actually being served: /model, /effort, /status, the strip, the picker, /config and /accounts agree
- A resumed or restarted session keeps its reasoning: the preserved-thinking notice no longer appears after a resume
- After a model switch or a context trim, one quiet line notes the dropped older reasoning instead of a warning on every message
- Usage meters refresh themselves and show their age; a stale or failed read says so, and the Anthropic usage panel no longer gets stuck on a rate-limit error
- A refused key or token names the setting to fix instead of reading "Not logged in"
- Removing or switching an account announces the change once; on the sign-in cards, c copies the code
- Images paste into the composer on every platform (ctrl+v; alt+v on Windows) at any size: a large image is resized to the provider's limits and the composer says what it attached
- Esc interrupts the chat's own turn only: sub-agents and workflows keep running and the transcript says how many; in the Crew view x x stops one agent and r resumes it
- Up arrow on an empty composer takes back a message sent while the turn was busy, before the model reads it; once read, the up arrow says so
- The text before a tool call is a one-line working note and the final answer never restates it
- Typing deepthink or supercode glows in your critter's colour, in the composer and in the sent message
- Selected text follows the view while you scroll, and the highlight stays inside the chat pane
- A mouse drag paints once and /mouse off is remembered across boots
- A mis-bound shortcut no longer flashes "Unknown command", and a split key sequence no longer leaks characters into the input
- The chat's title bar shows the session's name, and the row under the composer says how long your sub-agents have worked
- /rename works again and renames the session everywhere it is shown
- Compaction shows its progress in the chat (the stage, a bar, a clock) and Esc cancels it cleanly; a stalled or cancelled compaction keeps no half summary
- After a compaction Mercury still knows every agent, workflow and shell that is running or owed a result, so nothing is re-spawned or forgotten
- Trimming old tool results to fit the window is named as routine cleanup, never a "rewrote history" warning
- The seat ceiling is one number everywhere: /seats, the Boot Menu and /config set it, idle agents no longer hold a seat, and the reading counts available memory
- A waiting agent names what it is waiting for on its row, and a throttled agent's retries share one budget
- Sub-agents say once how they ended, with the real cause and what they wrote; a timeout is never blamed on you
- A background agent's completion shows in the chat the moment it arrives, marked queued until the model reads it
- The workflow panel, the board, the crew view and the chip agree on what is running, and read "not reported yet" instead of "idle" right after a start
- A sub-agent waiting on your permission reads "waiting for your answer" in the crew view and the tasks list
- A blocked team task reads blocked on every screen, and creating a team no longer hides earlier tasks
- The Concourse close chord does exactly what its hint says (stop, then archive, then delete), and a parked session reopens on one Enter
- A silent workflow stream is cut at the stall budget instead of waiting on the provider
- Sovereign mode asks nothing: sensitive-file edits, ask rules and a server's ask ceiling run without a card, and the transcript says what would have asked
- The mode band shows the mode the runner actually holds from the first frame, and a refused mode change reaches the screen with its reason
- Apollo mode ends only through the review's approval or shift+tab, and writes outside the spec directory are refused
- Flow's safety check keeps its evidence when it cannot read its own verdict and says so; a blocked action in a session you are not looking at waits for you there instead of being denied
- A hook's deny decision leaves its audit row in the transcript again
- Consent cards fit the screen: a long edit or command is cut with a "+N more lines" line and ctrl+f shows the whole thing
- Web search waits instead of failing: a throttled request cools down, a repeated query answers from the cache, and one line names what refused
- Godot: the editor is found where it lives, action presses are real input events, and runtime pause, step and resume drive a game frame by frame
- Unity test results land inside the project again, where the editor can write them
- The interrupt ends a running Bash command and says so; a request accepted with nothing arriving is named and ended
- /bug shows the exact report, files it through your own signed-in GitHub CLI, and masks every provider's key shape and GitHub tokens; /feedback opens the three-form chooser
- The Intel Mac build (macos-x64) ships with this release, and mercury update names it on an Intel Mac
- Release archives are signed and verified before they publish; an unsigned build is announced once per install; the archive carries the licence documents
- mercury update reads the release channel anonymously, so no GitHub CLI or sign-in is needed; an update whose signature does not verify is refused
- mercury install puts the command on your PATH once, and repeating it for the version already in place says so
- The doctor's launch row judges the last interactive boot in its true order, and a headless run is never judged as a broken boot
- No git init offer for the home directory, a drive root or a huge folder without a project marker; the doctor names a home-directory repository and how to remove it
- The project's .mercury folder holds shared config only; machine-local files live in your Mercury home, and the doctor names any leftovers
- Idle cost is down: no git or process spawns in the idle loop or at boot, and the daemon watches its files without polling
- A piped doctor --json prints exactly one record and exits with the verdict's code
- A headless stream-json run opens with its init line first
- The daemon reads sign-ins live, so a fresh /logins reaches hosted sessions without a restart
- Every tip the companion shows is true today and teaches one thing

## 1.0.0-beta.2
- The first published build of the public line; 1.0.0-beta.1 was tagged and never published
- The repository is github.com/Whq02/MercuryCLI; the app's update channel and the release bridge read it
- The daemon runs the model a dispatch names under either field spelling; an unknown id refuses, never the default in silence
- A permission ask that expires or is withdrawn always settles its needs-you row, even when the row was still being written
- Background start-up probes never hold the process open at exit
- On the Concourse board, Enter on an example prompt fills the composer and never sends it; the next Enter sends
- The close chord is a ladder: stop, then archive, then delete; the --chat face always shows the shift-arrow key row
- The split view's size floor is the viewport's (80 columns by 22 rows)
- The status row keeps a wait's budget word on a narrow terminal; a cold model switch names its first-byte budget
- Twelve Bash tool fixes: the sandbox allows its own temp dir, pipes keep the special parameters, here-strings read, the timeout note reaches the model, an unavailable sandbox is refused and named

## 1.0.0-beta.1
- The first build published from this repository; README.md says what is inside
- Release notes ship inside the build: this bundled changelog is the only source
- The scribe and router party modes are retired; the concourse is the multi-agent path
- Release archives carry their own Node runtime; a release install needs git only
- A direct node dist/mercury.mjs start paints the launch splash before the Boot face, as the launcher does; the build ships the splash beside the bundle
- Voice input: /speak on, then space in an empty composer dictates into it through the OpenAI or Gemini API key you signed in with; audio leaves only after you stop, and Mercury never speaks aloud
- True Black is the default appearance: the same palette on a pure-black ground, on the launch splash and in the terminal; the oasis dark ground stays one row away in the first-run walk and /appearance, and a saved choice always wins
- Two per-session switches in the boot menu's Agents section, Sub-agents and Workflows: off removes the Agent or Workflow tool from that session's roster and every spawn road answers one receipt; /subagents on|off and /workflows on|off flip a running session at its next turn boundary, and the doctor names both switches with their source
`
