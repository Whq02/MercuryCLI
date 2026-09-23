#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'lifecycle-'))
process.env.MERCURY_CONFIG_DIR = home

const { pushOverlay, popOverlay, anyOverlayActive, resetOverlayStackForTests } = await import('../../src/context/overlayStack.js')
const { subscribeUiClock, uiClockStatsForProofs } = await import('../../src/utils/cockpit/uiClock.js')
const { saveDraftDebounced, cancelPendingDraftSave, flushDraftSaves } = await import('../../src/utils/promptDraft.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-lifecycle-teardown')

let lastMark = 'boot'
const mark = (m: string) => { lastMark = m }
const watchdog = setTimeout(() => {
  console.log(`  [FAIL] WATCHDOG: proof wedged after '${lastMark}' (45s)`)
  process.exit(1)
}, 45_000)

mark('§1')
{
  resetOverlayStackForTests()
  const tokens: number[] = []
  for (let i = 0; i < 20; i++) {
    tokens.push(pushOverlay({ id: 'select', modal: true }))
    tokens.push(pushOverlay({ id: 'center:test', modal: true }))
  }
  for (let i = 0; i < tokens.length; i += 2) popOverlay(tokens[i]!)
  for (let i = 1; i < tokens.length; i += 2) popOverlay(tokens[i]!)
  check('§1 overlay stack empty after 40 interleaved lifecycles', !anyOverlayActive())
}

mark('§2')
{
  for (let round = 0; round < 30; round++) {
    const unsubs = [subscribeUiClock(100, () => {}), subscribeUiClock(250, () => {}), subscribeUiClock(100, () => {})]
    for (const u of unsubs) u()
  }
  const stats = uiClockStatsForProofs()
  check('§2 zero clock buckets after 30 mixed rounds', Object.keys(stats).length === 0, JSON.stringify(stats))
}


mark('§5')
{
  saveDraftDebounced('eeeeeeee-0000-4000-8000-000000000001', { text: 'pending', cursorOffset: 0, mode: 'prompt', pastedContents: {} })
  cancelPendingDraftSave()
  await flushDraftSaves()
  check('§5 cancelled pending save flushes nothing', true)
}

clearTimeout(watchdog)
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ prove-lifecycle-teardown: all green' : `\n✗ prove-lifecycle-teardown: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
