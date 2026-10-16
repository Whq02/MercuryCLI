#!/usr/bin/env bun
// gate-watch: src/utils/cockpit/commandPopup.ts src/components/CommandPopupSlot.tsx src/components/FullscreenLayout.tsx src/components/PopupGutter.tsx
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const store = await import('../../src/utils/cockpit/commandPopup.ts')
const slot = await import('../../src/components/CommandPopupSlot.tsx')

console.log('§1 the claim store: one claim at a time, released only by its own token')
{
  let notices = 0
  const unsubscribe = store.subscribeCommandPopup(() => { notices++ })
  check('nothing claimed at the start', store.commandPopupClaim() === null)
  const effort = { view: 'effort', width: () => 60, rows: () => 12 }
  const health = { view: 'health', width: () => 90, rows: () => 40 }
  const first = store.claimCommandPopup(effort)
  check('a claim publishes its shape', store.commandPopupClaim()?.shape === effort && notices === 1, `notices ${notices}`)
  const second = store.claimCommandPopup(health)
  check('a second claim takes the slot and hands out a new token', second !== first && store.commandPopupClaim()?.shape === health && store.commandPopupClaim()?.token === second)
  store.releaseCommandPopup(first)
  check('the first popup releasing on unmount leaves the second claim standing', store.commandPopupClaim()?.shape === health, String(store.commandPopupClaim()?.shape.view))
  const third = store.claimCommandPopup(effort)
  store.releaseCommandPopup(second)
  check('the same view opening twice: the older lease releasing never drops the newer claim', store.commandPopupClaim()?.token === third && store.commandPopupClaim()?.shape === effort)
  const before = notices
  store.releaseCommandPopup(second)
  check('a stale release notifies nobody', notices === before)
  store.releaseCommandPopup(third)
  check('the current token releasing clears the slot and notifies', store.commandPopupClaim() === null && notices === before + 1, `notices ${notices}`)
  unsubscribe()
  store.claimCommandPopup(effort)
  check('an unsubscribed listener hears nothing more', notices === before + 1)
  store.releaseCommandPopup(store.commandPopupClaim()!.token)
}

console.log('§2 the geometry: the shape asks, the host bounds, the popup centres on its own height')
{
  const host = { left: 31, top: 0, columns: 116, rows: 49 }
  const shape = { view: 'effort', width: (columns: number) => Math.min(100, columns - 2), rows: () => 13 }
  const g = slot.commandPopupGeometry(host, 51, shape)
  check('the width is the shape\'s word over the host columns', g.width === 100, String(g.width))
  check('the popup is centred in the host', g.left === host.left + Math.floor((host.columns - g.width) / 2), `left ${g.left}`)
  check('a short popup takes its own rows', g.rows === 13, String(g.rows))
  check('a short popup sits vertically centred on its own height, not on a taller budget', g.top === host.top + Math.ceil((host.rows - 13) / 2), `top ${g.top}`)
  const budget = slot.commandPopupGeometry(host, 51, { view: 'health', width: () => 100, rows: rows => Math.max(10, rows - 7) })
  check('the picker\'s row budget (rows − 7) stands when the host has room, centred', budget.rows === 44 && budget.top === host.top + Math.ceil((host.rows - 44) / 2), `rows ${budget.rows} top ${budget.top}`)
  const tall = slot.commandPopupGeometry(host, 51, { view: 'health', width: () => 100, rows: () => 60 })
  check('a budget taller than the host clamps to the host rows minus the gutter', tall.rows === host.rows - 2 && tall.top === host.top + 1, `rows ${tall.rows} top ${tall.top}`)
  const small = slot.commandPopupGeometry({ left: 0, top: 0, columns: 64, rows: 14 }, 20, shape)
  check('a 64×20 host: the width yields to the host and the rows to the host minus the gutter', small.width === 62 && small.rows === 12 && small.left === 1 && small.top === 1, `width ${small.width} rows ${small.rows} left ${small.left} top ${small.top}`)
  const tiny = slot.commandPopupGeometry({ left: 0, top: 0, columns: 20, rows: 3 }, 3, shape)
  check('a host too short for a popup yields a rows count that never goes negative', tiny.rows >= 0 && tiny.width >= 0)
}

console.log('§3 FullscreenLayout mounts the slot beside the model picker\'s, on the same claim-store road')
{
  const layout = readFileSync(join(ROOT, 'src/components/FullscreenLayout.tsx'), 'utf8')
  const picker = layout.indexOf('<ModelPickerPopupSlot ')
  const command = layout.indexOf('<CommandPopupSlot ')
  check('the command popup slot is mounted in the modal pane after the model picker slot', picker > 0 && command > picker)
  check('the layout reads the claim through useSyncExternalStore like the picker\'s', layout.includes('useSyncExternalStore(subscribeCommandPopup, commandPopupClaim, commandPopupClaim)'))
  check('the slot hosts the modal only while a modal is mounted', layout.includes('const commandPopupUp = commandPopup !== null && modalMounted'))
  const slotSrc = readFileSync(join(ROOT, 'src/components/CommandPopupSlot.tsx'), 'utf8')
  check('the slot measures its host with the model picker slot\'s own measurer and frames with PopupGutter', slotSrc.includes('modelPickerPopupHost(element, framed)') && slotSrc.includes('<PopupGutter {...geometry}>'))
  check('the slot re-measures on every layout pass (a resize re-fits the popup)', /useLayoutEffect\(\(\) => \{\n\s+const element = hostRef\.current/.test(slotSrc) && !/useLayoutEffect\([\s\S]*?\}, \[/.test(slotSrc))
}

console.log(`\ncommand-popup-slot: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
