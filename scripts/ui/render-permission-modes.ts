#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { daemonControlRpc } from '../../src/daemon/controlSocket.ts'
import { readSessionWorkers } from '../../src/daemon/concourseSupervisor.ts'
import { readSessionFacts } from '../../src/services/engine-connector/seatProjections.ts'
import { compactModeChip } from '../../src/components/mercury-ui/compactModeChip.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import type { PermissionMode } from '../../src/types/permissions.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { permissionModeSymbol, permissionModeTitle } = await import('../../src/utils/permissions/PermissionMode.ts')
const REPO = realpathSync(join(import.meta.dir, '..', '..'))
const VSHOT = join(import.meta.dir, 'vshot.py')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const MODES = ['strategy', 'apollo', 'implement', 'flow', 'sovereign'] as const
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length)
if (only !== undefined && !MODES.some(mode => mode === only)) throw new Error(`unknown mode: ${only}`)
let failures = 0

function check(label: string, passed: boolean, detail = ''): void {
  if (!passed) failures++
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

async function shoot(mode: PermissionMode, cols: number): Promise<string> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Band ready.', whenModel: 'opus' }])
  const home = mkdtempSync(join(tmpdir(), 'permission-band-home-'))
  const daemonDir = join(home, 'daemon')
  process.env.MERCURY_DAEMON_DIR = daemonDir
  seedFirstRun(home, [REPO])
  const out = join(tmpdir(), `permmode-${mode}-${cols}.json`)
  const expected = cols < 100
    ? compactModeChip(mode)!.text
    : `${permissionModeSymbol(mode)} ${permissionModeTitle(mode).toLowerCase()} on`
  const args = mode === 'sovereign'
    ? ['--sovereign']
    : ['--mode', mode === 'strategy' ? 'default' : mode]
  const sends: Array<Record<string, unknown>> = mode === 'sovereign'
    ? [
        { atTick: 120, requireAwait: true, awaitText: 'Yes, I accept', awaitSettleTicks: 3, data: '\x1b[B' },
        { afterPrevTicks: 2, requireAwait: true, awaitText: '❯ 2. Yes, I accept', data: '\r' },
      ]
    : []
  sends.push({ atTick: 120, afterPrevTicks: 120, requireAwait: true, awaitText: '↵ start', awaitSettleTicks: 5, data: '\r' })
  if (mode === 'strategy') sends.push(
    { afterPrevTicks: 120, requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: 'hello' },
    { afterPrevTicks: 2, requireAwait: true, awaitText: 'hello', data: '\r' },
    { afterPrevTicks: 120, requireAwait: true, awaitText: 'Band ready.', awaitSettleTicks: 2, data: '' },
  )
  const cfgPath = join(tmpdir(), `vshot-pm-${mode}-${cols}.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', BIN, ...args],
    cwd: REPO,
    sends,
    readyText: expected,
    readySettleTicks: 3,
    total: 200,
    cols,
    rows: 44,
    out,
  }))
  const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, ANTHROPIC_BASE_URL: api.url },
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: vshotBudgetMs(60000),
  })
  const capture = new Promise<{ status: number | null; stderr: string }>(resolve => {
    let stderr = ''
    child.stderr.on('data', data => { stderr += String(data) })
    child.on('error', error => { stderr += String(error) })
    child.on('close', status => resolve({ status, stderr }))
  })
  if (mode === 'strategy') {
    let sessionId: string | undefined
    const started = Date.now()
    while (Date.now() - started < vshotBudgetMs(30000) && child.exitCode === null) {
      sessionId = Object.values(readSessionWorkers(daemonDir)).find(record =>
        readSessionFacts(record.sessionId, daemonDir)?.permissionMode !== undefined,
      )?.sessionId
      if (sessionId !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    check(`strategy@${cols}: a real session reports its posture`, sessionId !== undefined)
    if (sessionId !== undefined) {
      const reply = await daemonControlRpc({ op: 'sessionControl', action: 'set-permission-mode', sessionId, by: 'operator', mode: 'strategy' }, { timeoutMs: vshotBudgetMs(10000) })
      check(`strategy@${cols}: the guarded explicit-mode door accepts Strategy`, reply.ok && (reply.outcome === 'applied' || reply.outcome === 'noop'), JSON.stringify(reply))
    }
  }
  const result = await capture
  await api.close()
  check(`${mode}@${cols}: capture exits cleanly`, result.status === 0, result.status === 0 ? '' : result.stderr)
  try {
    const frame = JSON.parse(readFileSync(out, 'utf8')) as {
      grid: Array<Array<{ c: string }>>
      readyAt: number | null
      refusals?: unknown[]
    }
    check(`${mode}@${cols}: the mode word settled without capture refusals`, frame.readyAt !== null && (frame.refusals?.length ?? 0) === 0)
    const text = frame.grid.map(row => row.map(cell => cell.c).join('').trimEnd()).join('\n')
    writeFileSync(join(tmpdir(), `permmode-${mode}-${cols}.txt`), text + '\n')
    return text
  } catch (error) {
    check(`${mode}@${cols}: a readable grid exists`, false, String(error))
    return ''
  }
}

for (const cols of [80, 120]) {
  for (const mode of MODES) {
    if (only !== undefined && mode !== only) continue
    const frame = await shoot(mode, cols)
    const symbol = permissionModeSymbol(mode)
    const title = permissionModeTitle(mode).toLowerCase()
    if (cols < 100) {
      check(`${mode}@${cols}: the compact band shows its symbol and words`, frame.includes(compactModeChip(mode)!.text))
      check(`${mode}@${cols}: the compact composer remains present`, frame.includes('Type a prompt'))
    } else {
      check(`${mode}@${cols}: the band shows "${symbol} ${title} on"`, frame.includes(`${symbol} ${title} on`))
      check(`${mode}@${cols}: the band keeps its posture or cycle hint`, mode === 'sovereign'
        ? frame.includes('all tool calls auto-approved')
        : frame.includes('shift+tab to cycle'))
    }
    if (mode === 'apollo' || mode === 'strategy') {
      check(`${mode}@${cols}: the shared diamond is named, not mistaken for the other mode`, frame.includes(`◇ ${title}`) && !frame.includes(`◇ ${mode === 'apollo' ? 'strategy' : 'apollo'} mode`))
    }
  }
}
console.log(`Frames: ${join(tmpdir(), 'permmode-<mode>-<cols>.{json,txt}')}`)
console.log(`permission-mode bands: ${failures === 0 ? 'GREEN' : `RED — ${failures} failures`}`)
process.exit(failures === 0 ? 0 : 1)
