import type { InputEvent, Key } from '../../../../ink.js'
import type { Draft, KeysArgs } from '../state.js'

export function wheelEscapeKeys(input: string, key: Key, event: InputEvent, { callbacks, boardArmedRef, boardSelRef, broadcastArmedRef, compact, compactGeo, filterRef, geo, markedIdsRef, olderListRef, region, rowPeekOpenRef, sessionRows, setBoardArmed, setBoardScroll, setBroadcastArmed, setComposeContext, setFilter, setGroundPickerOpen, setMarkedIds, setOlderList, setRegion, setRowPeekOpen }: KeysArgs, ctx: Draft['composeContext']): boolean {
  if (key.wheelUp || key.wheelDown) {
    const kp = event.keypress as { x?: number; y?: number }
    const compactListPainted = compactGeo?.profile === 'split' || (compactGeo?.profile === 'single' && region === 'list')
    const overList =
      kp.x !== undefined && kp.y !== undefined
        ? compactGeo !== null
          ? compactListPainted &&
            kp.x >= compactGeo.list.x0 + 1 &&
            kp.x <= compactGeo.list.x1 + 1 &&
            kp.y >= compactGeo.list.y0 + 2 &&
            kp.y <= compactGeo.list.y1
          : kp.y >= geo.listBand[0] &&
            kp.y <= geo.listBand[1] &&
            kp.x >= (geo.profile === 'wide' ? geo.rightCols[0] : 3) &&
            kp.x <= (geo.profile === 'wide' ? geo.rightCols[1] : 2 + geo.interior)
        : region === 'list'
    if (!overList) return true
    event.stopImmediatePropagation()
    if (sessionRows.length === 0) return true
    const dir = key.wheelDown ? 1 : -1
    setBoardScroll(v => {
      const base = v ?? Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current) - 1)
      return Math.max(0, Math.min(Math.max(0, sessionRows.length - 1), base + dir * (event.wheelStep ? 1 : 3)))
    })
    return true
  }
  if (key.ctrl && input === 'g') {
    event.stopImmediatePropagation()
    setGroundPickerOpen(v => !v)
    return true
  }
  if (key.escape) {
    event.stopImmediatePropagation()
    if (ctx.kind !== 'chat') {
      setComposeContext({ kind: 'chat' })
      return true
    }
    if (olderListRef.current !== null) {
      setOlderList(null)
      return true
    }
    if (broadcastArmedRef.current) {
      broadcastArmedRef.current = false
      setBroadcastArmed(false)
      return true
    }
    if (compact && region === 'live') {
      boardArmedRef.current = null
      setBoardArmed(null)
      setRegion('list')
      return true
    }
    if (boardArmedRef.current !== null) {
      boardArmedRef.current = null
      setBoardArmed(null)
      if (!compact) return true
    }
    if (rowPeekOpenRef.current) {
      setRowPeekOpen(false)
      return true
    }
    if (filterRef.current.text !== '') {
      filterRef.current = { text: '', caret: 0 }
      setFilter(filterRef.current)
      return true
    }
    if (markedIdsRef.current.size > 0) {
      setMarkedIds(new Set())
      return true
    }
    callbacks.exitToChat()
    return true
  }
  return false
}
