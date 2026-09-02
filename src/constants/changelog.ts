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

## 1.0.0-beta.1
- The first build published from this repository; README.md says what is inside
- Release notes ship inside the build: this bundled changelog is the only source
- The scribe and router party modes are retired; the concourse is the multi-agent path
`
