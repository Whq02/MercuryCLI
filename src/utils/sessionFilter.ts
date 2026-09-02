import type { LogOption } from '../types/logs.js'
import { workspaceRecognizedByGround } from './bootCardFacts.js'

//
// isSubstantiveSession — keep the resumable list (session switcher, /sessions
// manager) free of throwaway / "(no content)" sessions without ever hiding
// real user work.
//
// THE BUG IT FIXES: Mercury's session-flip lands on the most-recent resumable
// session. Render-test pollution left behind small command-only sessions —
// running `/sessions`, `/manager`, `/model` with no follow-up types a
// transcript whose only content is the slash command + a `(no content)` stdout.
// When the flip MRU points at one of those, the user sees `(no content)`.
//
// WHAT COUNTS AS SUBSTANTIVE (cheap signals only — this runs over every
// resumable LogOption, so it must not load files). loadAllProjectsMessageLogs
// only enriches the first N logs (the rest are LITE: firstPrompt='', but
// fileSize is REAL), so the size floor backstops both cases:
//   1. customTitle present  → the user named it, always keep.
//   2. ENRICHED with a GENUINE prompt — non-empty, not a placeholder
//      ('(session)' / 'No prompt'), not a command-only session — means real
//      interaction → keep. (extractFirstPrompt skips command-caveat noise and,
//      when the only user input was a slash command, falls back to the bare
//      command name, e.g. "/sessions".)
//   3. Otherwise (LITE firstPrompt='', a placeholder, or command-only): trust
//      the REAL byte size. At/above SUBSTANTIVE_FILE_SIZE the session has real
//      content; below it is trivial render-junk.
//
// Why command-only is gated by SIZE, not dropped outright: a SMALL command-only
// session (`/sessions` 3.9KB, `/model` 2KB, `/manager` 3.2KB) is exactly the
// "(no content)" render-junk the flip lands on — drop it. But a LARGE session
// whose first prompt is a command (the user opened a skill/command like
// `/terminal-ui-design` 15KB or `/rooms` 21KB and worked in it) is real work —
// keep it. We never hide real work to scrub a cosmetic junk row; preserving a
// resumable session always wins over dropping one.
//
// THRESHOLD (SUBSTANTIVE_FILE_SIZE = 4096): tuned from the operator's on-disk
// sessions. The smallest genuine session measured was 4389 bytes; trivial
// command-only render-junk (`/sessions`, `/manager`, `/model`) measured
// 1959–3897 bytes. 4096 is the largest round floor strictly below the smallest
// real session, so every real session is kept and the small command-only junk
// that produced "(no content)" is dropped.
//

export const SUBSTANTIVE_FILE_SIZE = 4096

// firstPrompt values that mean "no real prompt was extracted" — the enrich-time
// fallbacks (`extractFirstPrompt` → 'No prompt'; enrichLog → '(session)').
const PLACEHOLDER_PROMPTS = new Set(['(session)', 'No prompt'])

// A firstPrompt that is just a slash command or a raw command-message wrapper —
// these are sessions whose only user input was a command, never a real prompt
// (the "(no content)" render-junk class).
function isCommandOnlyPrompt(fp: string): boolean {
  const s = fp.trim()
  if (!s) return false
  if (
    s.startsWith('<command-name>') ||
    s.startsWith('<command-message>') ||
    s.startsWith('<local-command-caveat>') ||
    s.startsWith('<local-command-stdout>')
  ) {
    return true
  }
  // A leading bare slash-command token (e.g. "/sessions", "/manager"). Anchored
  // on the first character with no leading space, so a real prompt that merely
  // contains a slash mid-sentence won't match.
  return s.startsWith('/')
}

/**
 * True when a session is worth surfacing in the switcher / resume list. Keeps
 * every titled session and every session with a real first prompt; drops
 * placeholder / small command-only render-junk; and for everything without a
 * real prompt (LITE logs, placeholders, command-only) falls back to the
 * real-content size floor so large sessions are always kept. Never loads the
 * file — operates purely on the LogOption's already-loaded fields, so it is
 * safe over the partially-enriched list.
 */
export function isSubstantiveSession(log: LogOption): boolean {
  // 1. User named it — always keep.
  if (log.customTitle && log.customTitle.trim()) return true

  const fp = (log.firstPrompt ?? '').trim()

  // 2. A genuine, non-command, non-placeholder first prompt → real interaction.
  if (fp && !PLACEHOLDER_PROMPTS.has(fp) && !isCommandOnlyPrompt(fp)) {
    return true
  }

  // 3. No real prompt (LITE / placeholder / command-only): trust the real byte
  //    size — large sessions are real work, small ones are render-junk.
  return (log.fileSize ?? 0) >= SUBSTANTIVE_FILE_SIZE
}

//
// Project scoping (operator ask: "projects only contain sessions
// that are project-specific"). A session belongs to a project when its
// recorded cwd (LogOption.projectPath — the first message's cwd) is
// RECOGNIZED by the project's ground: the ONE recognition door
// (bootCardFacts.workspaceRecognizedByGround — the exact-key arm, then the
// walk-up arm with the nearest-cataloged-root carve). The picker and the
// concourse board now answer the SAME question through the same door — the
// former subtree-prefix join here is retired (frontier smart-recognition,
// operator-ruled). UNKNOWN cwd (old LITE logs, pre-projectPath
// transcripts) counts as IN-project: the pre-scoping surfaces treated those
// as current-project rows (rowProject's fallback), and silently vanishing
// real, resumable work on a missing metadata field would be data loss.
// The full cross-project history stays reachable via /resume (documented
// there) — the SWITCHER surfaces are the ones that scope.
//

/** True when `log` belongs to the project rooted at `root` (the one
 *  recognition door); unknown session cwd ⇒ true (see the header note —
 *  never hide real work). */
export function isProjectSession(log: LogOption, root: string): boolean {
  const raw = (log.projectPath ?? '').trim()
  if (!raw) return true
  if (!root.replace(/[\\/]+$/, '')) return true
  return workspaceRecognizedByGround(root, raw)
}

/** Split a resumable list into this project's sessions and the rest. */
export function partitionByProject(
  logs: readonly LogOption[],
  root: string,
): { inProject: LogOption[]; elsewhere: LogOption[] } {
  const inProject: LogOption[] = []
  const elsewhere: LogOption[] = []
  for (const l of logs) (isProjectSession(l, root) ? inProject : elsewhere).push(l)
  return { inProject, elsewhere }
}
