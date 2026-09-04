#!/usr/bin/env bun
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-homerepo-')))
const CAPTURE_DIR = process.env.MERCURY_HOMEREPO_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-home-repo-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
const userSite = spawnSync(driver.python, ['-c', 'import site; print(site.getusersitepackages())'], { encoding: 'utf8' }).stdout.trim()

const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const OFFER_TITLE = 'Start a git repository'
const RECEIPT = 'no git offer for'
const WARM_TICKS = 25
const LEG = process.env.MERCURY_HOMEREPO_LEG ?? 'both'
type Send = Record<string, unknown>
const QUIT: Send[] = [
  { afterPrevTicks: 3, data: '\x03' },
  { afterPrevTicks: 2, data: '\x03' },
  { afterPrevTicks: 4, data: '\x04' },
  { afterPrevTicks: 2, data: '\x04' },
]

interface Estate {
  home: string
  proj: string
  cfg: string
  bin: string
  shimLog: string
  traceDir: string
}

function estate(id: string, opts: { homeIsRepo: boolean; bulkFiles: number; nest?: string }): Estate {
  const root = join(SCRATCH, id)
  const home = join(root, 'home')
  const proj = join(home, ...(opts.nest ?? 'Desktop/proj').split('/'))
  const cfg = join(root, 'cfg')
  const bin = join(root, 'bin')
  const traceDir = join(root, 'trace')
  const shimLog = join(root, 'git-shim.log')
  for (const d of [join(proj, 'src'), cfg, bin, traceDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(proj, 'README.md'), '# proj\n')
  writeFileSync(join(proj, 'src', 'a.txt'), 'hello\n')
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = proof\n\temail = proof@example.invalid\n')
  const perDir = 500
  for (let d = 0; d < Math.ceil(opts.bulkFiles / perDir); d++) {
    const dd = join(home, 'Library', `bulk${String(d).padStart(3, '0')}`)
    mkdirSync(dd, { recursive: true })
    for (let f = 0; f < perDir; f++) writeFileSync(join(dd, `f${String(f).padStart(4, '0')}`), '')
  }
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/bash\nprintf '%s\\t%s\\t%s\\t%s\\n' "$(date +%s)" "$$" "$PWD" "$*" >> '${shimLog}'\nexport GIT_TRACE2_PERF='${traceDir}/'"$$"'.trace'\nexec '${REAL_GIT}' "$@"\n`,
  )
  chmodSync(join(bin, 'git'), 0o755)
  if (opts.homeIsRepo) {
    const g = (args: string[]): void => {
      const r = spawnSync(REAL_GIT, args, { cwd: home, env: { ...process.env, HOME: home }, stdio: 'pipe', encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    }
    g(['init', '-q'])
    g(['commit', '-q', '--allow-empty', '-m', 'mercury: base commit — forking unlocked'])
  }
  seedFirstRun(cfg, [home, proj])
  return { home, proj, cfg, bin, shimLog, traceDir }
}

type Capture = { status: number; tail: string; marks: Record<string, string>; text: string }

async function capture(e: Estate, id: string, cwd: string, sends: Send[], total: number): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${id}.json`)
  const outPath = join(SCRATCH, `grid-${id}.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--model', 'claude-sonnet-5'], cwd, cols: 120, rows: 40, sends, total, out: outPath }))
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      HOME: e.home,
      USERPROFILE: e.home,
      ...(userSite !== '' ? { PYTHONPATH: userSite } : {}),
      PATH: `${e.bin}:${process.env.PATH ?? ''}`,
      MERCURY_CONFIG_DIR: e.cfg,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_SPLASH: 'off',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolveDone => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.on('close', status => {
      const marks: Record<string, string> = {}
      let text = ''
      try {
        const payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
        const grid = payload.grid as Array<Array<{ c: string }>>
        text = grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n')
        if (CAPTURE_DIR) writeFileSync(join(CAPTURE_DIR, `${id}.txt`), text + '\n')
        for (const mark of (payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []) {
          const t = mark.grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n')
          marks[mark.label] = t
          if (CAPTURE_DIR) writeFileSync(join(CAPTURE_DIR, `${id}--${mark.label}.txt`), t + '\n')
        }
      } catch {
      }
      resolveDone({ status: status ?? 1, tail, marks, text })
    })
  })
  try {
    await api.close()
  } catch {
  }
  return result
}

function printFrame(id: string, text: string): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of text.split('\n')) console.log(`│${l}`)
  console.log('└──')
}

function reap(e: Estate): void {
  try {
    const recs = JSON.parse(readFileSync(join(e.cfg, 'daemon', 'session-workers.json'), 'utf8')) as Record<string, { pid?: number }>
    for (const r of Object.values(recs)) {
      if (r.pid !== undefined) {
        try {
          process.kill(r.pid, 'SIGTERM')
        } catch {
        }
      }
    }
  } catch {
  }
  try {
    const pid = Number(readFileSync(join(e.cfg, 'daemon', 'daemon.pid'), 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
  } catch {
  }
}

if (LEG !== 'D2') {
console.log('D1 — a defaulted launch colliding in the (plain) home gets NO git offer; the rail carries the receipt')
  const e = estate('d1', { homeIsRepo: false, bulkFiles: 0 })
  const c = await capture(e, 'd1-refused-at-home', e.home, [
    { atTick: 150, awaitText: READY_LINE, minTick: 3, awaitSettleTicks: 3, data: '', mark: 'face' },
    { afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' },
    { afterPrevTicks: 100, awaitText: COMPOSER, awaitSettleTicks: 4, data: 'hello', mark: 'chat' },
    { afterPrevTicks: 3, data: '\r', mark: 'sent' },
    { afterPrevTicks: 60, awaitText: 'Spare.', awaitSettleTicks: 3, data: '', mark: 'reply' },
    { afterPrevTicks: 5, data: '\x1b[1;2D', mark: 'to-board' },
    { afterPrevTicks: 40, data: 'write a haiku', mark: 'board' },
    { afterPrevTicks: 4, data: '\r', mark: 'dispatch' },
    { afterPrevTicks: 100, awaitText: RECEIPT, awaitSettleTicks: 3, data: '', mark: 'receipt' },
    { afterPrevTicks: 30, data: '', mark: 'settled' },
    ...QUIT,
  ], 600)
  const receipt = c.marks.receipt ?? ''
  const settled = c.marks.settled ?? ''
  printFrame('d1 (the board after the refused launch)', settled || c.text)
  check('D1 the receipt reached the rail ("no git offer for …")', receipt.includes(RECEIPT), c.tail.slice(-300))
  check('D1 no "Start a git repository" card was offered', !receipt.includes(OFFER_TITLE) && !settled.includes(OFFER_TITLE))
  check('D1 the home has NO .git afterwards', !existsSync(join(e.home, '.git')))
  const sidecar = join(e.cfg, 'daemon', 'git-init-asks.json')
  const sidecarRows = existsSync(sidecar) ? (JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, string>) : {}
  check('D1 no git-init ask row was minted for the home', !Object.values(sidecarRows).includes(e.home), JSON.stringify(sidecarRows))
  let receiptRow: { ref: string; question: string } | undefined
  let askRow = false
  try {
    const store = JSON.parse(readFileSync(join(e.cfg, 'crew', 'obligations-switchboard.json'), 'utf8')) as { obligations: Record<string, { ref: string; question: string }> }
    for (const o of Object.values(store.obligations)) {
      if (o.ref.startsWith('git-refused:') && o.question.includes(e.home)) receiptRow = o
      if (o.ref.startsWith('permission:git-init:')) askRow = true
    }
  } catch {
  }
  check('D1 the obligation store holds the refusal receipt and no git-init ask', receiptRow !== undefined && !askRow)
  check('D1 the receipt names the reason and says kept without git', receiptRow?.question.includes('this is your home folder') === true && receiptRow?.question.includes('kept without git') === true, receiptRow?.question)
  let rows: Array<{ heldReason?: string; reason?: string; sessionId?: string; state?: string }> = []
  try {
    const ledger = JSON.parse(readFileSync(join(e.cfg, 'daemon', 'concourse-dispatches.json'), 'utf8')) as { dispatches?: Record<string, { heldReason?: string; reason?: string; sessionId?: string; state?: string }> } & Record<string, unknown>
    const table = (ledger.dispatches ?? ledger) as Record<string, { heldReason?: string; reason?: string; sessionId?: string; state?: string }>
    rows = Object.values(table).filter(r => r !== null && typeof r === 'object' && 'state' in r)
  } catch {
  }
  const summary = rows.map(r => `${r.state}/${r.heldReason ?? '-'}/${r.sessionId !== undefined ? 'started' : 'no-session'}: ${(r.reason ?? '').slice(0, 90)}`).join(' | ')
  check('D1 no launch was ever held on the git offer (no-repository / unborn-head)', rows.length > 0 && rows.every(r => r.heldReason !== 'no-repository' && r.heldReason !== 'unborn-head'), summary)
  check('D1 the launch waits as a plain collision whose reason says kept without git', rows.some(r => r.sessionId === undefined && (r.reason ?? '').includes('kept without git')), summary)
  reap(e)
}

if (LEG !== 'D1') {
console.log('\nD2 — from a project nested under a home repository (Documents/voxel), no probe scans above the launch folder')
  const BULK = 15_000
  const NEST = 'Documents/voxel'
  const e = estate('d2', { homeIsRepo: true, bulkFiles: BULK, nest: NEST })
  const top = spawnSync(REAL_GIT, ['-C', e.proj, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: { ...process.env, HOME: e.home } }).stdout.trim()
  check('D2 the nested Documents folder resolves to the home root today (git says so)', realpathSync(top) === realpathSync(e.home), top)
  const c = await capture(e, 'd2-nested-boot', e.proj, [
    { atTick: 150, awaitText: READY_LINE, minTick: 3, awaitSettleTicks: 3, data: '', mark: 'face' },
    { afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' },
    { afterPrevTicks: 100, awaitText: COMPOSER, awaitSettleTicks: 4, data: 'hello', mark: 'chat' },
    { afterPrevTicks: 3, data: '\r', mark: 'sent' },
    { afterPrevTicks: 60, awaitText: 'Spare.', awaitSettleTicks: 3, data: '', mark: 'reply' },
    { afterPrevTicks: 120, data: '', mark: 'idle' },
    { afterPrevTicks: 5, data: '\x1b[1;2D', mark: 'to-board' },
    { afterPrevTicks: 60, data: '', mark: 'board' },
    ...QUIT,
  ], 700)
  check('D2 the chat ran (the reply landed)', (c.marks.reply ?? '').includes('Spare.'), c.tail.slice(-300))
  reap(e)
  const rows = existsSync(e.shimLog) ? readFileSync(e.shimLog, 'utf8').split('\n').filter(Boolean) : []
  const visited = (pid: string): number => {
    const f = join(e.traceDir, `${pid}.trace`)
    if (!existsSync(f)) return -1
    const m = [...readFileSync(f, 'utf8').matchAll(/paths-visited:(\d+)/g)].map(x => Number(x[1]))
    return m.length ? m.reduce((a, b) => a + b, 0) : -1
  }
  type Row = { pid: string; cwd: string; args: string; effCwd: string }
  const parsed: Row[] = rows.map(r => {
    const [, pid, cwd, args] = r.split('\t') as [string, string, string, string]
    const m = /(?:^| )-C ([^ ]+)/.exec(args)
    return { pid, cwd, args, effCwd: m ? m[1]! : cwd }
  })
  const probes = parsed.filter(r => /(^| )(status|add|ls-files)( |$)/.test(r.args))
  console.log(`  [CENSUS] ${rows.length} git calls, ${probes.length} status/add/ls-files probes:`)
  const shapes = new Map<string, { n: number; max: number }>()
  for (const p of probes) {
    const key = `${p.args.replace(e.home, '$HOME')} @ ${p.effCwd.replace(e.home, '$HOME')}`
    const cur = shapes.get(key) ?? { n: 0, max: -1 }
    cur.n++
    cur.max = Math.max(cur.max, visited(p.pid))
    shapes.set(key, cur)
  }
  for (const [k, v] of shapes) console.log(`    ${String(v.n).padStart(3)}×  paths-visited≤${v.max}  ${k}`)
  check('D2 the boot issued status/add/ls-files probes at all', probes.length >= 3, String(probes.length))
  const unbounded = probes.filter(r => !(r.args.endsWith('-- .') || r.args.endsWith(`-- ${NEST}`)))
  check('D2 every status/add/ls-files probe carries the boundary pathspec', unbounded.length === 0, unbounded.map(r => r.args).join(' | '))
  const heavy = probes.filter(r => visited(r.pid) > 200)
  check(`D2 no probe visited more than 200 paths (the home holds ${BULK}+ entries)`, heavy.length === 0, heavy.map(r => `${r.args}=${visited(r.pid)}`).join(' | '))
  const atHome = probes.filter(r => r.effCwd === e.home && !r.args.endsWith(`-- ${NEST}`))
  check('D2 no probe ran at the home root without the boundary pathspec', atHome.length === 0, atHome.map(r => r.args).join(' | '))
}

if (process.env.MERCURY_HOMEREPO_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-home-repo-drive: ALL LAWS HOLD' : `\nprove-home-repo-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
