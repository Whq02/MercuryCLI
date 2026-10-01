import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ASK, MODEL, REPO, argAfter, authWorld, nodeFor, proofRoot, runChild } from './authRetryFixture.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const dist = resolve(argAfter('--dist') ?? join(REPO, 'dist/mercury.mjs'))
const root = proofRoot()
const before = process.argv.includes('--before')
const size = argAfter('--size')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(`${driver.reason}: ${driver.remedy}`)
const sizes = [[80, 21], [80, 14], [82, 17], [120, 40]]
let failures = 0
for (const [cols, rows] of sizes) {
  if (size && size !== `${cols}x${rows}`) continue
  const world = await authWorld('unchanged', '20')
  const env = { ...world.env, TMPDIR: '.', MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE, VSHOT_SLOTS: process.env.VSHOT_SLOTS }
  const session = randomUUID()
  try {
    const seed = await runChild([nodeFor(dist), dist, 'run', '--format', 'json', '--model', MODEL, '--session-id', session, 'seed fixture session'], world.cwd, env, 60_000)
    if (seed.code !== 0) throw new Error(`seed failed: ${seed.stderr}\n${seed.stdout}`)
    const out = join(root, `${cols}x${rows}.json`)
    const needle = before ? 'Retrying in' : 'sign-in expired'
    const cfg = {
      argv: [nodeFor(dist), dist, '--model', MODEL, '--resume', session], cwd: world.cwd,
      sends: [
        { atTick: 70, minTick: 3, awaitText: 'Yes, I accept', awaitSettleTicks: 2, data: '\x1b[B\r' },
        { atTick: 100, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
        { atTick: 150, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 3, data: ASK },
        { atTick: 160, afterPrevTicks: 3, awaitText: ASK, awaitSettleTicks: 2, data: '\r' },
        { atTick: 240, minTick: 10, awaitText: needle, awaitSettleTicks: 4, data: '', mark: 'row' },
      ],
      readyText: needle, readySettleTicks: 2, total: 260, cols, rows, out,
    }
    const config = join(root, `${cols}x${rows}-config.json`)
    writeFileSync(config, JSON.stringify(cfg))
    const result = await runChild([driver.python, captureEngineEntry(driver, REPO), config], world.cwd, env, vshotBudgetMs(90_000))
    const payload = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
    const grid = payload?.marks?.find((mark: { label: string }) => mark.label === 'row')?.grid ?? payload?.grid
    const lines: string[] = grid ? grid.map((row: Array<{ c: string }>) => row.map(cell => cell.c || ' ').join('')) : []
    const text: string = grid ? lines.join('\n') : result.stderr
    writeFileSync(join(root, `${cols}x${rows}.txt`), text + '\n')
    const requests = world.wires.filter(wire => wire.kind === 'request')
    const refreshes = world.wires.filter(wire => wire.kind === 'refresh')
    const record = { home: world.home, dist, code: result.code, endReason: payload?.endReason, wires: world.wires }
    writeFileSync(join(root, `${cols}x${rows}-record.json`), JSON.stringify(record, null, 2) + '\n')
    const paneStart = Math.max(0, (lines.find(line => line.includes('✶ VIEW')) ?? '').indexOf('│'))
    const words = (grid ? lines.map(line => line.slice(paneStart)).join('\n') : text).replace(/[│┃]/g, ' ').replace(/\s+/g, ' ')
    const ok = result.code === 0 && words.includes('Anthropic sign-in expired') && words.includes('/logins anthropic') && words.includes('fixture@example.invalid') && !words.includes('Retrying in') && requests.length === 1 && refreshes.length === 1
    if (!ok) failures++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${cols}x${rows}: one refresh, one attributed blocker, no wait; requests=${requests.length} refreshes=${refreshes.length} capture=${result.code}; ${join(root, `${cols}x${rows}.txt`)}`)
  } finally {
    process.env.MERCURY_CONFIG_DIR = world.home
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_DAEMON_DIR = world.env.MERCURY_DAEMON_DIR
    const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
    const cwdBefore = process.cwd()
    const tmpBefore = process.env.TMPDIR
    try {
      process.chdir(world.cwd)
      process.env.TMPDIR = '.'
      await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => undefined)
    } finally {
      process.chdir(cwdBefore)
      if (tmpBefore === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = tmpBefore
      world.close()
    }
  }
}
console.log(`prove-authentication-retry-frames: ${failures} failed; frames ${root}`)
process.exit(failures ? 1 : 0)
