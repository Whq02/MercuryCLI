
import { getSessionId } from '../bootstrap/state.js'

export function getTerminalPanelSocket(): string {
  return `claude-panel-${String(getSessionId()).slice(0, 8)}`
}
