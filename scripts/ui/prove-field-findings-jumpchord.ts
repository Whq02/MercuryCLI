#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 ctr-4 — the advertised chord fires')
{
  const { parseKeystroke } = await import('../../src/keybindings/parser.ts')
  const { matchesKeystroke } = await import('../../src/keybindings/match.ts')
  const key = { ctrl: false, meta: true, shift: false, super: false, downArrow: true } as unknown as Parameters<typeof matchesKeystroke>[1]
  check('the wire fact: alt+down arrives as meta+↓ and the matcher folds alt/meta into one', matchesKeystroke('', key, parseKeystroke('alt+down')))
  const bindings = read('src/keybindings/defaultBindings.ts')
  const scroll = bindings.slice(bindings.indexOf("context: 'Scroll'"), bindings.indexOf("context: 'Help'"))
  check("the Scroll context binds alt+down to scroll:bottom (beside the ctrl+end the pill's drill already proved live)", scroll.includes("'alt+down': 'scroll:bottom',") && scroll.includes("'ctrl+end': 'scroll:bottom',"))
  const layout = read('src/components/FullscreenLayout.tsx')
  check('the pill still advertises the chord it now has', layout.includes("'[ back to the bottom · alt+↓ ]'") && layout.includes('· alt+↓ ]`'))
}
console.log('§2 the transcript viewer — PgUp paints the pill, PgDn clears it, alt+↓ jumps')
{
  const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
  const driver = resolveCaptureDriver()
  const BIN = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(BIN)) {
    check('dist/mercury.mjs exists (build first)', false)
  } else if (driver.kind !== 'posix-pty') {
    console.log(`  (skipped: capture driver ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind})`)
  } else {
    const { CONFIG_HOME, cleanupScenario, scenario } = await import('./renderScenarios.ts')
    const PAGE_UP = '\x1b[5~'
    const PAGE_DOWN = '\x1b[6~'
    const ALT_DOWN = '\x1b[1;3B'
    const CTRL_O = '\x0f'
    const PILL = '[ back to the bottom · alt+↓ ]'
    const cfg = scenario('cockpit-scrolled', 150, 40) as Record<string, unknown>
    const press = (n: number, data: string) => Array.from({ length: n }, () => ({ afterPrevTicks: 2, data }))
    const frame = (mark: string) => ({ afterPrevTicks: 4, awaitStableTicks: 3, data: '', mark })
    cfg.sends = [
      { atTick: 90, minTick: 40, awaitText: 'RECENT', awaitSettleTicks: 2, data: CTRL_O },
      { afterPrevTicks: 4, awaitText: 'detailed transcript', requireAwait: true, awaitSettleTicks: 2, data: '' },
      ...press(8, PAGE_UP),
      frame('paged-up'),
      ...press(10, PAGE_DOWN),
      frame('paged-down'),
      ...press(8, PAGE_UP),
      frame('paged-up-again'),
      { afterPrevTicks: 1, data: ALT_DOWN },
      frame('jumped'),
    ]
    delete cfg.readyText
    delete cfg.stableTicks
    cfg.total = 240
    const gridPath = `/tmp/jumpchord-grid-${process.pid}.json`
    const cfgPath = `/tmp/jumpchord-cfg-${process.pid}.json`
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
    const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_OPERATOR: 'op', MERCURY_CHANNEL_ROOM: `jumpchord-${process.pid}` },
    })
    check('the viewer journey delivered every send', res.status === 0, (res.stderr ?? '').trim().slice(-300))
    if (res.status === 0) {
      const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
      const frames: Record<string, string[]> = {}
      for (const m of payload.marks ?? []) frames[m.label] = m.grid.map(row => row.map(c => c.c).join('').trimEnd())
      const rows = (label: string): string[] => frames[label] ?? []
      const pillRow = (label: string): number => rows(label).findIndex(l => l.includes(PILL))
      const has = (label: string, needle: string): boolean => rows(label).some(l => l.includes(needle))
      check('the viewer is open (its own footer)', has('paged-up', 'detailed transcript'))
      check('PgUp scrolled the view (the first reply is on screen)', has('paged-up', 'Reply 1:'))
      check('PgUp painted the pill with its words', pillRow('paged-up') > 0, `row ${pillRow('paged-up')}`)
      check('PgDn back to the bottom cleared the pill', pillRow('paged-down') === -1 && !has('paged-down', 'Reply 1:'))
      check('the bottom is back after PgDn (the last reply is on screen)', has('paged-down', 'Reply 18:'))
      check('PgUp again paints the pill again', pillRow('paged-up-again') > 0 && has('paged-up-again', 'Reply 1:'))
      check('alt+↓ jumped to the bottom and cleared the pill', pillRow('jumped') === -1 && has('jumped', 'Reply 18:') && !has('jumped', 'Reply 1:'))
    }
    cleanupScenario('cockpit-scrolled')
  }
}

process.exit(failures === 0 ? 0 : 1)
