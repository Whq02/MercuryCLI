#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'pasted-prompt-row-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPERATOR = 'sam'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const frameIndex = process.argv.indexOf('--frames')
const frameDir = frameIndex < 0 ? undefined : process.argv[frameIndex + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const quoted = '<local-command-caveat>The rows below are commands'
const { scenario, cleanupScenario, SID } = await import('../ui/renderScenarios.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const root = join(import.meta.dir, '..', '..')
const body = `pasted visible head\n${'ordinary prompt text '.repeat(50)}\nThe header quoted "${quoted}".\npasted visible tail`
const reply = 'Seen pasted prompt.'
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'paced' as const, deltas: [reply], gapMs: 0, startDelayMs: 2500 })))
const daemonHome = join(home, 'daemon')
mkdirSync(daemonHome, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonHome
const childEnv = { ...process.env, ANTHROPIC_BASE_URL: api.url, MERCURY_AWAY_SUMMARY: '0' }
let daemonLog = ''
const daemon = spawn('node', [join(root, 'dist/mercury.mjs'), 'daemon', 'run', root], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
const daemonReady = new Promise<boolean>(settle => {
  const ceiling = setTimeout(() => settle(false), vshotBudgetMs(60000))
  const onData = (chunk: Buffer): void => {
    daemonLog += String(chunk)
    if (daemonLog.includes('control socket up')) {
      clearTimeout(ceiling)
      settle(true)
    }
  }
  daemon.stdout.on('data', onData)
  daemon.stderr.on('data', onData)
  daemon.on('exit', () => {
    clearTimeout(ceiling)
    settle(false)
  })
})
check('the isolated fixture daemon is ready', await daemonReady, daemonLog.slice(-180))
type Capture = { grid: { c: string }[][]; marks?: { label: string; grid: { c: string }[][] }[] }
const rowsOf = (grid: { c: string }[][]): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd())
try {
  for (const band of [{ cols: 178, rows: 51 }, { cols: 80, rows: 21 }, { cols: 120, rows: 40 }]) {
    const cfg = scenario('resume-2turn', band.cols, band.rows)
    const out = join(home, `${band.cols}-drive.json`)
    const config = `${out}.cfg.json`
    const sends = [
      { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 3, data: `\x1b[200~${body}\x1b[201~` },
      { awaitText: '[Pasted text #1', requireAwait: true, awaitSettleTicks: 3, data: '', mark: 'chip' },
      { awaitText: '[Pasted text #1', requireAwait: true, awaitSettleTicks: 1, data: '\r' },
      { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2, data: '', mark: 'sent' },
      { awaitText: reply, requireAwait: true, awaitSettleTicks: 3, data: '', mark: 'replied' },
    ]
    writeFileSync(config, JSON.stringify({ ...cfg, argv: ['node', join(root, 'dist/mercury.mjs'), '--resume', SID, '--model', 'claude-sonnet-5'], sends, readyText: reply, total: 360, ...band, out }))
    const result = await new Promise<{ code: number | null; stderr: string }>(settle => {
      const child = spawn('/usr/bin/python3', [join(root, 'scripts/ui/vshot.py'), config], { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const ceiling = setTimeout(() => child.kill(), vshotBudgetMs(240000))
      child.on('exit', code => { clearTimeout(ceiling); settle({ code, stderr }) })
    })
    let capture: Capture | undefined
    try { capture = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
    check(`${band.cols}: the real paste-chip send and fixture response complete`, result.code === 0, `rc ${result.code} ${result.stderr.slice(-250)}`)
    const marks = Object.fromEntries((capture?.marks ?? []).map(mark => [mark.label, rowsOf(mark.grid)]))
    for (const [name, rows] of Object.entries(marks)) if (frameDir !== undefined) writeFileSync(join(frameDir, `drive-${band.cols}x${band.rows}-${name}.txt`), rows.join('\n') + '\n')
    check(`${band.cols}: the composer really made a paste chip`, (marks.chip ?? []).some(row => row.includes('│❯') && row.includes('[Pasted text #1')))
    const sent = marks.sent ?? []
    const sentRow = band.cols >= 100 ? sent.some(row => row.includes('[sam]') && row.includes('pasted visible head')) : sent.some(row => row.includes('pasted visible tail'))
    check(`${band.cols}: the operator's row stands as soon as the paste is sent, before the reply`, sentRow, sent.filter(row => row.includes('pasted') || row.includes('[sam]')).join(' | '))
    const rows = marks.replied ?? []
    check(`${band.cols}: the sent paste is visible beside the reply, not silently dropped`, rows.some(row => row.includes('pasted visible tail')) && rows.some(row => row.includes(reply)) && !rows.some(row => row.includes('│❯') && row.includes('[Pasted text')), rows.filter(row => row.includes('pasted')).join(' | '))
    cleanupScenario('resume-2turn')
  }
  const requests = api.messageRequests()
  check('the model receives the full pasted text including the literal markup', requests.some(request => JSON.stringify(request.body).includes('pasted visible head') && JSON.stringify(request.body).includes(quoted) && JSON.stringify(request.body).includes('pasted visible tail')), `${requests.length} requests`)
} finally {
  try { await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never) } catch {}
  daemon.kill()
  await api.close()
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-pasted-prompt-row: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
