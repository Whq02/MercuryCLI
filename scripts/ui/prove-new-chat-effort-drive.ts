#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = join(import.meta.dir, '../..')
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = resolve(argument('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = argument('--frames')
const SCRATCH = join(realpathSync('/tmp'), `mercury-chat-effort-${process.pid}`)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
const textOf = (grid: Grid): string => grid.map(row => row.map(c => c.c).join('').trimEnd()).join('\n')
type WorkerRecord = { sessionId: string; pid?: number; effort?: string; endedAt?: number }
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

if (!existsSync(DIST)) throw new Error(`Built bundle absent: ${DIST}`)
mkdirSync(SCRATCH, { recursive: true })
console.log(`build under proof: ${DIST}`)

type World = { tag: string; cols: number; rows: number; saved: string | null; expected: string }
const worlds: World[] = [
  { tag: 'saved-max-80x21', cols: 80, rows: 21, saved: 'max', expected: 'max' },
  { tag: 'saved-max-80x14', cols: 80, rows: 14, saved: 'max', expected: 'max' },
  { tag: 'saved-max-82x17', cols: 82, rows: 17, saved: 'max', expected: 'max' },
  { tag: 'saved-max-120x40', cols: 120, rows: 40, saved: 'max', expected: 'max' },
  { tag: 'nothing-saved-120x40', cols: 120, rows: 40, saved: null, expected: 'high' },
]

for (const world of worlds) {
  console.log(`\n── ${world.tag}`)
  const home = join(SCRATCH, world.tag, 'home')
  const cwd = join(SCRATCH, world.tag, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'notes.txt'), 'a folder with one commit\n')
  for (const args of [['init', '-q'], ['add', 'notes.txt'], ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', 'commit', '-q', '-m', 'base']]) {
    const git = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: join(SCRATCH, world.tag) } })
    if (git.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${git.stderr}`)
  }
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify(world.saved === null ? {} : { effortLevel: world.saved }))
  const out = join(SCRATCH, world.tag, 'grid.json')
  const full = world.cols >= 100 && world.rows >= 26
  const bornNeedle = full ? ' ready \u00b7 ' : '1 session on'
  const stripPrompt = 'hello from the strip'
  const cfg = {
    argv: ['node', DIST],
    cwd,
    cols: world.cols,
    rows: world.rows,
    total: full ? 200 : 120,
    out,
    liveSeat: true,
    ...(full ? {} : { readyText: bornNeedle, readySettleTicks: 6 }),
    sends: [
      { requireAwait: true, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, data: '\r', mark: 'face' },
      { requireAwait: true, awaitText: bornNeedle, minTick: 1, awaitSettleTicks: 4, data: '', mark: 'born' },
      ...(full
        ? [
            { afterPrevTicks: 2, data: '\x1b[1;2D', mark: 'to-concourse' },
            { requireAwait: true, awaitText: 'coordinator', minTick: 1, awaitSettleTicks: 6, data: `${stripPrompt}\r`, mark: 'strip-sent' },
            { afterPrevTicks: 40, data: '', mark: 'strip-born' },
          ]
        : []),
    ],
  }
  const cfgPath = join(SCRATCH, world.tag, 'capture.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const recordsFile = join(home, 'daemon', 'concourse-workers.json')
  const records = new Map<string, WorkerRecord & { title?: string; bornBlankAt?: number; execEnvEffort?: string | null; factsEffort?: string | null }>()
  const sampler = setInterval(() => {
    if (!existsSync(recordsFile)) return
    try {
      const file = JSON.parse(readFileSync(recordsFile, 'utf8')) as { workers?: Record<string, WorkerRecord & { title?: string; bornBlankAt?: number }> }
      for (const live of Object.values(file.workers ?? {})) {
        if (live.endedAt !== undefined || typeof live.pid !== 'number' || live.effort === undefined) continue
        const known = records.get(live.sessionId)
        const ps = known?.execEnvEffort !== undefined ? null : spawnSync('ps', ['-E', '-o', 'command=', '-p', String(live.pid)], { encoding: 'utf8' })
        const execEnvEffort = known?.execEnvEffort !== undefined ? known.execEnvEffort : (/MERCURY_EFFORT_LEVEL=(\S+)/.exec(ps?.stdout ?? '')?.[1] ?? null)
        let factsEffort = known?.factsEffort ?? null
        if (factsEffort === null) {
          const factsFile = join(home, 'daemon', 'session-facts', `${live.sessionId}.json`)
          if (existsSync(factsFile)) {
            const facts = JSON.parse(readFileSync(factsFile, 'utf8')) as { effort?: string }
            if (typeof facts.effort === 'string') factsEffort = facts.effort
          }
        }
        records.set(live.sessionId, { ...live, execEnvEffort, factsEffort })
      }
    } catch {
      return
    }
  }, 300)
  let engineLog = ''
  const status = await new Promise<number | null>(resolvePromise => {
    const engine = spawn('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
      cwd,
      env: {
        ...process.env,
        MERCURY_FULLSCREEN: '1',
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        ANTHROPIC_API_KEY: FIXTURE_API_KEY,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        OPENAI_BASE_URL: 'http://127.0.0.1:1',
        BROWSER: '/usr/bin/true',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_TERMINAL_TITLE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => engine.kill('SIGKILL'), vshotBudgetMs(180_000))
    engine.stdout.on('data', chunk => { engineLog += String(chunk) })
    engine.stderr.on('data', chunk => { engineLog += String(chunk) })
    engine.on('close', code => { clearTimeout(timer); resolvePromise(code) })
  })
  clearInterval(sampler)
  writeFileSync(join(SCRATCH, world.tag, 'engine.log'), engineLog)
  check(`${world.tag}: the capture ran to its end`, status === 0 && existsSync(out), `status ${status}: ${engineLog.trim().split('\n').slice(-3).join(' | ')}`)
  const undelivered = /UNDELIVERED-SENDS/.test(engineLog)
  check(`${world.tag}: every send became due`, !undelivered, engineLog.split('\n').filter(l => l.includes('UNDELIVERED')).join(' '))
  let bornText = ''
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf-8')) as { marks: Mark[] }
    const born = payload.marks.find(m => m.label === 'born')
    bornText = born ? textOf(born.grid) : ''
    writeFileSync(join(SCRATCH, world.tag, 'born.txt'), `${bornText}\n`)
  }
  check(`${world.tag}: a hosted chat was born (its ready row painted)`, bornText.includes(bornNeedle))
  const all = [...records.values()]
  const faceBorn = all.find(r => r.bornBlankAt !== undefined)
  const brief = (r: (typeof all)[number] | undefined) => JSON.stringify(r === undefined ? null : { sessionId: r.sessionId, effort: r.effort, pid: r.pid, title: r.title, factsEffort: r.factsEffort })
  check(`${world.tag}: the face-born worker's record carries '${world.expected}'`, faceBorn?.effort === world.expected, brief(faceBorn))
  const daemonLog = existsSync(join(home, 'daemon', 'daemon.log')) ? readFileSync(join(home, 'daemon', 'daemon.log'), 'utf8') : ''
  const admitted = daemonLog.split('\n').filter(l => l.includes('concourse worker admitted'))
  check(`${world.tag}: the daemon admitted the face-born worker at '${world.expected}'`, admitted.length > 0 && admitted[0]!.includes(`@${world.expected},`), admitted.join(' | ').slice(0, 300))
  check(`${world.tag}: the face-born seat's facts carry the runner's applied word '${world.expected}'`, faceBorn?.factsEffort === world.expected, String(faceBorn?.factsEffort))
  if (full) {
    const stripBorn = all.find(r => r.bornBlankAt === undefined && r.title === stripPrompt)
    check(`${world.tag}: a second chat was born through the New Session strip`, stripBorn !== undefined, all.map(brief).join(' | '))
    check(`${world.tag}: the strip-born worker's record carries '${world.expected}'`, stripBorn?.effort === world.expected, brief(stripBorn))
    check(`${world.tag}: the daemon admitted the strip-born worker at '${world.expected}'`, admitted.length > 1 && admitted[1]!.includes(`@${world.expected},`), admitted.join(' | ').slice(0, 300))
  }
  const stripRow = bornText.split('\n').find(l => /(?:[\u25cf\u2726\u25c6] |effort )(max|high|xhigh|medium|low)\b/.test(l)) ?? ''
  console.log(`  strip: ${stripRow.trim().slice(0, 100) || '(no effort word on this size)'} · exec-time env of the face-born runner ${String(faceBorn?.execEnvEffort)}`)
  if (FRAMES) {
    const destination = join(resolve(FRAMES), world.tag)
    mkdirSync(destination, { recursive: true })
    for (const name of ['born.txt', 'grid.json', 'capture.json', 'engine.log']) {
      const file = join(SCRATCH, world.tag, name)
      if (existsSync(file)) writeFileSync(join(destination, name), readFileSync(file))
    }
    writeFileSync(join(destination, 'records.json'), `${JSON.stringify(all, null, 2)}\n`)
  }
  await pause(500)
}

if (failures > 0) {
  console.log(`\nnew chat effort: RED (${failures}/${checks}) — artifacts at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nnew chat effort: green (${checks} checks)`)
