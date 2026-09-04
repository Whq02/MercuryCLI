// ============================================================================
//  MERCURY_CHANGELOG — the bundled release notes.
//
//  Mercury is a standalone product: its release notes are authored here and
//  ship inside the build — there is no remote CHANGELOG fetch.
//
//  Format contract (parseChangelog in utils/releaseNotes.ts):
//    ## <semver>            — one section per version, NEWEST FIRST
//    - <note>               — bullet lines only; other lines are ignored
//
//  Update alongside MERCURY_VERSION (src/constants/product.ts): the startup
//  "what's new" banner shows a version's bullets once (lastReleaseNotesSeen
//  latches), and /release-notes prints the full history.
// ============================================================================

export const MERCURY_CHANGELOG = `# Mercury changelog

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
