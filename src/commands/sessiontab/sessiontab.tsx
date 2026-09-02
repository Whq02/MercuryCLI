import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { filterResumableSessions } from '../resume/resume.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { isProjectSession, isSubstantiveSession } from '../../utils/sessionFilter.js'
import { isSessionCleared } from '../../utils/sessionStorage/clearedSessions.js'
import {
  getSessionIdFromLog,
  isLiteLog,
  loadAllProjectsMessageLogs,
  loadFullLog,
} from '../../utils/sessionStorage.js'

// ============================================================================
//  /sessiontab — flip to your most-recently-used OTHER session, in-place.
//
//  A no-UI tab-flip (Alt-Tab between sessions): loads the resumable sessions
//  (the same honest source /sessions + the MercuryFrame tab-strip use), picks the
//  newest OTHER session, and swaps to it via the REPL's context.resume — the
//  exact in-place switch /sessions ↵ performs. Because the just-left session is
//  now the most-recent "other", repeating the chord toggles A↔B; with 3+ it acts
//  as most-recently-used, like Alt-Tab.
//
//  HONEST: single-process, switch-not-concurrent — the outgoing session pauses
//  (its JSONL preserved) and resumes on flip-back. Nothing faked.
//
//  Bound to Option/Alt+←/→ on an empty prompt by PromptInput (ctrl+arrow would
//  collide with the macOS "switch Spaces" shortcut); hidden from the slash menu
//  (isHidden) but runnable as /sessiontab. Flag-gated; bare-stamp build no-ops.
//
//  `/sessiontab <session-id>` (trust-cockpit W4) flips to THAT session — the
//  tab-strip's clickable ▢ tabs dispatch this targeted form. Argless behavior
//  is byte-identical to before (most-recent other).
// ============================================================================
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const live = context.resume
  if (!live) {
    onDone(undefined, { display: 'skip' })
    return null
  }
  try {
    const all = await loadAllProjectsMessageLogs()
    // Drop sidechains + the current session, then drop throwaway / "(no content)"
    // render-junk so the flip never lands on an empty command-only session (the
    // original bug). isSubstantiveSession is safe over LITE logs (size-gated).
    const resumable = filterResumableSessions(all, getSessionId())
      .filter(isSubstantiveSession)
      // PROJECT SCOPE: Alt-Tab flips within THIS
      // project's sessions only — /resume is the cross-project reach.
      .filter(l => isProjectSession(l, getProjectRoot() || ''))
      // /clear'ed sessions never re-enter the flip ring (cleared cache).
      .filter(l => !isSessionCleared(getSessionIdFromLog(l)))
    // Newest-first — the most-recent other session is the flip target.
    resumable.sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    )
    // Targeted flip: an exact session-id arg picks that session out of the SAME
    // resumable set (never an arbitrary id). A stale/vanished target — the tab
    // was cleared, closed, or belongs to another project — produces an honest
    // NOTICE instead of silently switching to some other session (which read
    // as "it flipped me to the wrong session").
    const wanted = (args ?? '').trim()
    if (wanted && !resumable.some(l => getSessionIdFromLog(l) === wanted)) {
      onDone(
        `Session ${wanted.slice(0, 8)}… is no longer in this project's flip ring (cleared, removed, or another project's). /resume reaches the full history.`,
        { display: 'system' },
      )
      return null
    }
    const target = wanted
      ? resumable.find(l => getSessionIdFromLog(l) === wanted)
      : resumable[0]
    if (!target) {
      onDone('No other session to flip to — this is the only one.', {
        display: 'system',
      })
      return null
    }
    const sessionId = getSessionIdFromLog(target)
    if (!sessionId) {
      onDone(undefined, { display: 'skip' })
      return null
    }
    // Lite logs carry no messages — load the full transcript before the swap.
    const fullLog = isLiteLog(target) ? await loadFullLog(target) : target
    await context.resume!(sessionId, fullLog, 'slash_command_picker')
    // resume() swapped the transcript in-place; nothing more to render.
    onDone(undefined, { display: 'skip' })
  } catch {
    onDone(undefined, { display: 'skip' })
  }
  return null
}
