import { helpKeyFiresFor } from '../../controlManifest.js'
import { nudgeSplitRatio, toggleSplitView } from '../../splitView.js'
import { hasFocusedSession, landingInFlight } from '../../../../engine/connector/focusedConnector.js'
import { NL } from '../useConcourseDraft.js'
import type { InputEvent, Key } from '../../../themedRenderer.js'
import type { KeysArgs } from '../state.js'

export function chatChordKeys(input: string, key: Key, event: InputEvent, { callbacks, boardSelRef, compact, enterSession, helpOpenRef, liveDraftRef, moveBoardSelection, pastGate, region, rowPauseToggle, rowStop, selectedIsDoor, sendLive, sessionRows, setHelpOpen, showDoorNote, termCols, termRows }: KeysArgs, olderNavConsumed: (key: { upArrow: boolean; downArrow: boolean }, event: { stopImmediatePropagation: () => void }) => boolean): boolean {
  if (region === 'chat') {
    if (key.return && pastGate()) {
      event.stopImmediatePropagation()
      if (hasFocusedSession()) callbacks.exitToChat()
      else if (!landingInFlight()) callbacks.newSession?.()
      return true
    }
    if (input === 's' && !key.ctrl && !key.meta && pastGate()) {
      event.stopImmediatePropagation()
      toggleSplitView(termCols, termRows)
      return true
    }
    if ((input === '[' || input === ']') && !key.ctrl && !key.meta && pastGate()) {
      event.stopImmediatePropagation()
      nudgeSplitRatio(input === '[' ? -1 : 1)
      return true
    }
  }
  if (
    (region === 'live' && (key.upArrow || key.downArrow) && !liveDraftRef.current.text.includes(NL)) ||
    (region === 'chat' && (key.upArrow || key.downArrow))
  ) {
    if (olderNavConsumed(key, event)) return true
    event.stopImmediatePropagation()
    moveBoardSelection(key.downArrow ? 1 : -1)
    return true
  }
  if (
    input === '?' &&
    !key.ctrl &&
    !key.meta &&
    helpKeyFiresFor(region, liveDraftRef.current.text.length === 0)
  ) {
    event.stopImmediatePropagation()
    helpOpenRef.current = true
    setHelpOpen(true)
    return true
  }
  if (compact && region === 'live' && !key.ctrl && !key.meta && (input === 'x' || input === 'p') && liveDraftRef.current.text.length === 0 && pastGate()) {
    event.stopImmediatePropagation()
    if (input === 'x') rowStop()
    else rowPauseToggle()
    return true
  }
  if (key.return && !key.shift) {
    if (region !== 'live') return true
    event.stopImmediatePropagation()
    if (!pastGate()) return true
    if (compact && selectedIsDoor()) {
      showDoorNote()
      return true
    }
    if (liveDraftRef.current.text.trim().length === 0) {
      const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
      if (sel) enterSession(sel.sessionId)
      return true
    }
    sendLive()
    return true
  }
  return false
}
