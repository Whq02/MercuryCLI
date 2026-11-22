import type { UUID } from 'node:crypto'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { getTranscriptPath, saveAgentName, saveCustomTitle } from '../../utils/sessionStorage.js'
import { isCompactBoundaryMessage } from '../../services/messages.js'
import { generateSessionName } from './generateSessionName.js'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import { notBuilt } from '../../pi/holes.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<null> {
  return notBuilt('src/commands/rename/rename.ts:10')
}
