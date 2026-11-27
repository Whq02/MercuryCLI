#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)
const DOWN = `${ESC}[B`

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-picker-landing-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' /model — a picker opened while the chat lands keeps its cursor')
console.log('============================================================')

const gate = await import('../../src/commands/model/modelPickerLandingGate.tsx')
const focused = await import('../../src/engine/connector/focusedConnector.ts')
const WORDS = gate.MODEL_PICKER_LANDING_WORDS
const PICKER = 'PICKER PAINTED'

section('THE GATE off-screen: the landing line while a landing is in flight, the picker once it settles')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const stripAnsi = (await import('strip-ansi')).default
  const React = (await import('react')).default
  const { render, Text } = await import('../../src/screen/themedRenderer.js')
  const mount = async (ceilingMs?: number) => {
    let output = ''
    const stdout = new PassThrough()
    stdout.on('data', c => { output += c.toString() })
    ;(stdout as unknown as { columns?: number; rows?: number }).columns = 120
    ;(stdout as unknown as { columns?: number; rows?: number }).rows = 40
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode() { return this },
      setEncoding() { return this },
      read() { return null },
      get readableLength() { return 0 },
      unref() { return this },
      ref() { return this },
      pause() { return this },
      resume() { return this },
    }) as unknown as NodeJS.ReadStream
    const instance = await render(
      React.createElement(
        gate.MercuryModelLandingGate,
        ceilingMs === undefined ? {} : { ceilingMs },
        React.createElement(Text, null, PICKER),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
    )
    return {
      seen: (): string => stripAnsi(output),
      clear: (): void => { output = '' },
      unmount: (): void => instance.unmount(),
    }
  }

  {
    const landing = focused.withLanding(sleep(800))
    const view = await mount()
    await sleep(300)
    check('300 ms into an 800 ms landing the slot paints the landing line', view.seen().includes(WORDS), `MercuryModelLandingGate in src/commands/model/modelPickerLandingGate.tsx must paint MODEL_PICKER_LANDING_WORDS while focusedConnector.withLanding is in flight; screen tail: ${view.seen().slice(-200)}`)
    check('…and not the picker', !view.seen().includes(PICKER), 'the gate in src/commands/model/modelPickerLandingGate.tsx must not render its children while a landing is in flight')
    view.clear()
    await landing
    await sleep(150)
    check('once the landing settles the picker paints', view.seen().includes(PICKER), `MercuryModelLandingGate in src/commands/model/modelPickerLandingGate.tsx must render its children once the landing settles; screen tail: ${view.seen().slice(-200)}`)
    check('the landing edge cleared the gate (no landing in flight)', !focused.landingInFlight(), 'withLanding in src/engine/connector/focusedConnector.ts must clear its in-flight mark when the landing promise settles')
    view.unmount()
  }
  {
    void focused.withLanding(new Promise<void>(() => {}))
    const view = await mount(300)
    await sleep(120)
    check('a landing that never settles holds the landing line first', view.seen().includes(WORDS) && !view.seen().includes(PICKER), `the gate in src/commands/model/modelPickerLandingGate.tsx must show the landing line before its ceiling; screen tail: ${view.seen().slice(-200)}`)
    view.clear()
    await sleep(450)
    check('…and past the ceiling the picker paints anyway', view.seen().includes(PICKER), `the gate in src/commands/model/modelPickerLandingGate.tsx must give up waiting at its ceilingMs and render the picker; screen tail: ${view.seen().slice(-200)}`)
    view.unmount()
    focused._resetFocusedSessionConnectorForTesting()
  }
  {
    const view = await mount()
    await sleep(120)
    check('with no landing in flight the picker paints at once', view.seen().includes(PICKER) && !view.seen().includes(WORDS), `the gate in src/commands/model/modelPickerLandingGate.tsx must render its children at once when focusedConnector.landingInFlight() is false; screen tail: ${view.seen().slice(-200)}`)
    view.unmount()
  }
  check(`the ceiling is a bounded moment (${gate.MODEL_PICKER_LANDING_CEILING_MS} ms), well under the daemon door's timeout`, gate.MODEL_PICKER_LANDING_CEILING_MS >= 1_000 && gate.MODEL_PICKER_LANDING_CEILING_MS < 30_000, 'set MODEL_PICKER_LANDING_CEILING_MS in src/commands/model/modelPickerLandingGate.tsx between 1000 and 30000 ms')
}


section('THE SCREEN: /model opened as the chat lands; two arrow keys at the first paint stay put (120x40)')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind}) — the screen leg cannot run here`)
  failures++
} else if (!existsSync(BIN)) {
  console.error(`  dist/mercury.mjs missing — bun run build.ts first`)
  failures++
} else {
  const home = resolveProofHome([REPO])
  const grid = join(SCRATCH, 'landing-120x40.json')
  const cfgPath = join(SCRATCH, 'vshot.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, requireAwait: true, awaitSettleTicks: 2, data: CR },
        { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 1, data: CR },
        { afterPrevTicks: 8, awaitText: WORDS.slice(0, 28), minTick: 1, data: '', mark: 'opened' },
        { requireAwait: true, awaitText: 'Mercury · model', awaitSettleTicks: 1, data: DOWN + DOWN, mark: 'painted' },
        { afterPrevTicks: 2, data: '', mark: 'walked' },
        { afterPrevTicks: 25, data: '', mark: 'settled' },
        { afterPrevTicks: 2, data: ESC },
      ],
      total: 150,
      cols: 120,
      rows: 40,
      out: grid,
      title: 'picker landing cursor @120x40',
    }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    },
    timeout: vshotBudgetMs(90_000),
  })
  check('the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-300)}`)
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      marks?: Array<{ label: string; atTick: number; grid: Array<Array<{ c: string }>> }>
    }
    const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
    const frame = (label: string): string => {
      const m = payload.marks?.find(x => x.label === label)
      return m === undefined ? '' : text(m.grid)
    }
    const focusRow = (t: string): string => {
      const rows = t.split('\n')
      const title = rows.find(row => row.includes('Mercury · model')) ?? ''
      const at = title.indexOf('Mercury · model')
      const left = title.lastIndexOf('│', at)
      const right = title.indexOf('│', at)
      if (left < 0 || right < 0) return ''
      const row = rows.map(line => line.slice(left, right + 1)).find(line => line.includes('│ ❯ ')) ?? ''
      return row.split('│ ❯ ')[1]?.replace(/\s{2,}.*$/, '').trim() ?? ''
    }
    const opened = frame('opened')
    const painted = frame('painted')
    const walked = frame('walked')
    const settled = frame('settled')
    console.log(`  [info] the landing line was on screen at the open: ${opened.includes(WORDS.slice(0, 28)) ? 'yes — the open fell inside the landing window' : 'no — this box landed before the picker opened'}`)
    check('the picker painted', painted.includes('Mercury · model'), `the /model picker never reached its first paint in the drive; check the landing gate in src/commands/model/modelPickerLandingGate.tsx and run scripts/ui/vshot.py by hand; first rows: ${painted.split('\n').filter(l => l.trim()).slice(0, 6).join(' / ')}`)
    check('the picker painted after the landing: the served model row is current at the first paint', /\S\s{2,}current\s{2,}/.test(painted) && !painted.includes(WORDS.slice(0, 28)), `the first paint must come after the landing, with the served model marked current and the landing line gone (src/commands/model/modelPickerLandingGate.tsx); current row: ${painted.split('\n').find(l => l.includes('current')) ?? '(no current row)'}`)
    check('the two arrow keys moved the cursor', focusRow(walked) !== '' && focusRow(walked) !== focusRow(painted), `the two down arrows sent at the first paint must move the picker cursor (src/commands/model/picker); painted: ${focusRow(painted)} · walked: ${focusRow(walked)}`)
    check('five seconds on, the cursor is where the keys put it', focusRow(settled) === focusRow(walked), `nothing may reset the cursor after the landing settles (the gate in src/commands/model/modelPickerLandingGate.tsx and the picker under src/commands/model/picker); walked: ${focusRow(walked)} · settled: ${focusRow(settled)}`)
    check('…in the same open (the picker never closed)', settled.includes('Mercury · model') && /\S\s{2,}current\s{2,}/.test(settled), 'the picker closed or lost its current row before the settled frame; the gate in src/commands/model/modelPickerLandingGate.tsx must not remount the picker after the landing')
  } else {
    check('the capture wrote its grid', false, 'vshot.py wrote no grid file; run scripts/ui/vshot.py by hand with the config and read its stderr')
  }
  try {
    const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ a picker opened while the chat lands keeps its cursor' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
