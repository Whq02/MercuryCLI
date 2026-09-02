import { basename, join } from 'node:path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isTabulaEnabled, tabulaProjectDir } from '../../utils/tabula/tabulaGates.js'
import { appendEvents, materializeNotepad, newNoteId } from '../../utils/tabula/tabulaStore.js'
import { bumpHelmLanesVersion } from '../../utils/cockpit/helmFocus.js'

// `/note <text>` — one-keypress capture into the TABULA project notepad.
// Zero model turns; the note lands in the per-project journal (private, under
// the Mercury config home) and the notepad.md mirror re-materializes. The
// plain file on disk is the notepad's face (the /tabula surface is Minerva's
// room now and offers no note-leaving).
export const call: LocalCommandCall = async args => {
  if (!isTabulaEnabled()) {
    return { type: 'text', value: 'The notepad is off this session (MERCURY_TABULA=0) — nothing captured.' }
  }
  const text = (args ?? '').trim()
  const cwd = getOriginalCwd()
  const dir = tabulaProjectDir(cwd)
  if (!text) {
    return {
      type: 'text',
      value: `Usage: \`/note <a note to keep, or something to do later>\` — notes land in ${join(dir, 'notepad.md')}.`,
    }
  }
  const id = newNoteId()
  appendEvents(dir, [{ t: new Date().toISOString(), op: 'add', id, text }])
  materializeNotepad(dir, basename(cwd) || 'project')
  // Every journal-mutation origin nudges the lanes pane (the fireTracker
  // precedent) — without it the cockpit's TABULA card sits stale until an
  // unrelated rail event.
  bumpHelmLanesVersion()
  return {
    type: 'text',
    value: `Captured \`${id}\` — ${text.length > 60 ? `${text.slice(0, 60)}…` : text}  (notepad: ${join(dir, 'notepad.md')})`,
  }
}
