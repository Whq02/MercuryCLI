import type { InputEvent, Key } from '../../../themedRenderer.js'
import type { KeysArgs } from '../state.js'

export function railKeys(input: string, key: Key, event: InputEvent, { snapshot, callbacks, beginAnswer, openObligationOrDoor, pastGate, railSelRef, region, setRailSel }: KeysArgs): boolean {
  if (region === 'rail') {
    const liveRailIdx = (): number =>
      Math.max(0, snapshot.needsYou.findIndex(o => o.obligationId === railSelRef.current))
    if (key.upArrow || key.downArrow) {
      event.stopImmediatePropagation()
      const n = snapshot.needsYou.length
      if (n > 0) {
        const next = Math.min(n - 1, Math.max(0, liveRailIdx() + (key.downArrow ? 1 : -1)))
        railSelRef.current = snapshot.needsYou[next]?.obligationId ?? null
        setRailSel(railSelRef.current)
      }
      return true
    }
    if (key.return && pastGate()) {
      event.stopImmediatePropagation()
      const o = snapshot.needsYou[liveRailIdx()]
      if (o) beginAnswer(o.obligationId)
      return true
    }
    if (input === 'o' && !key.ctrl && !key.meta && pastGate()) {
      event.stopImmediatePropagation()
      const o = snapshot.needsYou[liveRailIdx()]
      if (o) openObligationOrDoor(o.obligationId)
      return true
    }
    if (input === 'w' && !key.ctrl && !key.meta && pastGate()) {
      event.stopImmediatePropagation()
      const o = snapshot.needsYou[liveRailIdx()]
      if (o) callbacks.withdrawObligation(o.obligationId)
      return true
    }
  }
  return false
}
