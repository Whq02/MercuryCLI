
import { getSessionId } from '../bootstrap/state.js'

export function getTerminalPanelSocket(): string {
  return `mercury-panel-${String(getSessionId()).slice(0, 8)}`
}
