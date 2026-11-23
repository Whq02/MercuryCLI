#!/usr/bin/env bun
// gate-watch: src/screen/cockpit/commandPopup.ts src/screen/overlays/CommandPopupSlot.tsx src/screen/fullscreen-layout/FullscreenLayout.tsx src/screen/overlays/PopupGutter.tsx

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const store = await import('../../src/screen/cockpit/commandPopup.ts')
const slot = await import('../../src/screen/overlays/CommandPopupSlot.tsx')

console.log('§1 the claim store: one claim at a time, released only by its own token')
{
  let notices = 0
  const unsubscribe = store.subscribeCommandPopup(() => { notices++ })
  check('nothing claimed at the start', store.commandPopupClaim() === null)
  const effort = { view: 'effort', width: () => 60, rows: () => 12 }
  const health = { view: 'health', width: () => 90, rows: () => 40 }
  const first = store.claimCommandPopup(effort)
  check('a claim publishes its shape', store.commandPopupClaim()?.shape === effort && notices === 1, `claimCommandPopup in src/screen/cockpit/commandPopup.ts must store the shape and notify subscribers once; notices ${notices}`)
  const second = store.claimCommandPopup(health)
  check('a second claim takes the slot and hands out a new token', second !== first && store.commandPopupClaim()?.shape === health && store.commandPopupClaim()?.token === second, 'claimCommandPopup in src/screen/cockpit/commandPopup.ts must replace the standing claim and return a fresh token')
  store.releaseCommandPopup(first)
  check('the first popup releasing on unmount leaves the second claim standing', store.commandPopupClaim()?.shape === health, `releaseCommandPopup in src/screen/cockpit/commandPopup.ts must ignore a token that is not the current claim; standing view: ${String(store.commandPopupClaim()?.shape.view)}`)
  const third = store.claimCommandPopup(effort)
  store.releaseCommandPopup(second)
  check('the same view opening twice: the older lease releasing never drops the newer claim', store.commandPopupClaim()?.token === third && store.commandPopupClaim()?.shape === effort, 'releaseCommandPopup in src/screen/cockpit/commandPopup.ts must compare tokens, not views')
  const before = notices
  store.releaseCommandPopup(second)
  check('a stale release notifies nobody', notices === before, 'releaseCommandPopup in src/screen/cockpit/commandPopup.ts must return without notifying when the token is stale')
  store.releaseCommandPopup(third)
  check('the current token releasing clears the slot and notifies', store.commandPopupClaim() === null && notices === before + 1, `releaseCommandPopup in src/screen/cockpit/commandPopup.ts must clear the slot and notify once for the current token; notices ${notices}`)
  unsubscribe()
  store.claimCommandPopup(effort)
  check('an unsubscribed listener hears nothing more', notices === before + 1, 'the function subscribeCommandPopup returns in src/screen/cockpit/commandPopup.ts must remove the listener')
  store.releaseCommandPopup(store.commandPopupClaim()!.token)
}

console.log('§2 the geometry: the shape asks, the host bounds, the popup centres on its own height')
{
  const host = { left: 31, top: 0, columns: 116, rows: 49 }
  const shape = { view: 'effort', width: (columns: number) => Math.min(100, columns - 2), rows: () => 13 }
  const g = slot.commandPopupGeometry(host, 51, shape)
  check('the width is the shape\'s word over the host columns', g.width === 100, `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must take the width from the shape, bounded by the host columns; width ${g.width}`)
  check('the popup is centred in the host', g.left === host.left + Math.floor((host.columns - g.width) / 2), `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must centre the popup horizontally in the host; left ${g.left}`)
  check('a short popup takes its own rows', g.rows === 13, `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must use the shape's own rows when they fit; rows ${g.rows}`)
  check('a short popup sits vertically centred on its own height, not on a taller budget', g.top === host.top + Math.ceil((host.rows - 13) / 2), `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must centre on the popup's own height; top ${g.top}`)
  const budget = slot.commandPopupGeometry(host, 51, { view: 'health', width: () => 100, rows: rows => Math.max(10, rows - 7) })
  check('the picker\'s row budget (rows − 7) stands when the host has room, centred', budget.rows === 44 && budget.top === host.top + Math.ceil((host.rows - 44) / 2), `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must keep the shape's row budget when the host has room, centred; rows ${budget.rows} top ${budget.top}`)
  const tall = slot.commandPopupGeometry(host, 51, { view: 'health', width: () => 100, rows: () => 60 })
  check('a budget taller than the host clamps to the host rows minus the gutter', tall.rows === host.rows - 2 && tall.top === host.top + 1, `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must clamp rows to the host rows minus the gutter; rows ${tall.rows} top ${tall.top}`)
  const small = slot.commandPopupGeometry({ left: 0, top: 0, columns: 64, rows: 14 }, 20, shape)
  check('a 64×20 host: the width yields to the host and the rows to the host minus the gutter', small.width === 62 && small.rows === 12 && small.left === 1 && small.top === 1, `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must shrink width and rows to fit a small host; width ${small.width} rows ${small.rows} left ${small.left} top ${small.top}`)
  const tiny = slot.commandPopupGeometry({ left: 0, top: 0, columns: 20, rows: 3 }, 3, shape)
  check('a host too short for a popup yields a rows count that never goes negative', tiny.rows >= 0 && tiny.width >= 0, `commandPopupGeometry in src/screen/overlays/CommandPopupSlot.tsx must clamp negative sizes to zero; rows ${tiny.rows} width ${tiny.width}`)
}


console.log(`\ncommand-popup-slot: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
