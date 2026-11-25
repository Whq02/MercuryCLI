#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageRollbackScene } from './rollbackScene.ts'

if (process.platform === 'win32') {
  console.log('prove-rollback-second-home-window-drive: [SKIP] the staged release install is the POSIX one')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(driver.kind === 'unavailable' ? `${driver.reason}: ${driver.remedy}` : 'the window needs the POSIX capture driver')

const TREE = resolve(import.meta.dir, '..', '..')
const REOPEN = 'close this window and open Mercury again'
const capture = realpathSync(mkdtempSync(join(tmpdir(), 'rbw-')))
const scene = stageRollbackScene()
const { was, next } = scene
const second = scene.otherHome(2, { ANTHROPIC_API_KEY: FIXTURE_API_KEY })
seedFirstRun(second.dir, [scene.project])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix screenIsOlder in src/daemon/control/handshake.ts: the installed build decides before the version word does`}`)
}

console.log('============================================================')
console.log(' after a rollback, a second home\'s new window is not told to reopen')
console.log('============================================================')
try {
  const up = await scene.runningNext([second])
  check(`the staged install runs v${next} with v${was} kept behind it, and the second home's daemon is up on v${next}`, up.ok, up.detail)
  const rolled = await scene.rollBack([second])
  check(`the first home rolls back to v${was}, and the second home's daemon logs it`, rolled.said.status === 0 && rolled.logged, `${rolled.said.out} · ${rolled.detail}`)

  const out = join(capture, 'window.json')
  const config = join(capture, 'window-config.json')
  writeFileSync(config, JSON.stringify({ argv: [scene.command], cwd: scene.project, cols: 120, rows: 40, out, total: 600, sends: [{ awaitText: 'New Session', requireAwait: true, awaitSettleTicks: 4, data: '\r' }], readyText: 'Type a prompt', readySettleTicks: 25 }))
  await new Promise<void>(done => {
    const child = spawn(driver.python, [captureEngineEntry(driver, TREE), config], { cwd: TREE, env: { ...second.env, TERM: 'xterm-256color', MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()) }, stdio: 'ignore' })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
    child.on('close', () => {
      clearTimeout(deadline)
      done()
    })
  })
  const grid = (existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { grid?: Array<Array<{ c?: string }>> }).grid : undefined) ?? []
  const frame = grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
  console.log(frame.split('\n').filter(line => line.trim() !== '').slice(-6).map(line => `    | ${line}`).join('\n'))
  check(`a new window under the second home, v${was}, opens its chat`, frame.includes('Type a prompt'), frame.slice(-600))
  check(`and is not told that v${next} is installed, nor to close and open again`, frame.includes('Type a prompt') && !frame.includes(`v${next} is installed`) && !frame.includes(REOPEN), frame.split('\n').filter(line => line.includes('installed') || line.includes(REOPEN)).join(' · '))
} finally {
  scene.end()
  removeScratch(capture)
}

console.log(failures === 0 ? '\nprove-rollback-second-home-window-drive: ALL HOLD' : `\nprove-rollback-second-home-window-drive: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
