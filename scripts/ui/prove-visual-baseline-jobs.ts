#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const GENERATOR = join(ROOT, 'scripts/ui/generate-visual-baseline.ts')
const RED_GRIDS = [
  'help--120x40--dark--truecolor--full',
  'frame--120x40--dark--none--full',
  'sessions--120x40--dark-ansi--truecolor--full',
]

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const vb = (await import('./visualBaseline.ts')) as Record<string, unknown>
type Send = Record<string, unknown>
type Cfg = { sends?: Send[]; readyText?: string | string[]; stableTicks?: number; total?: number; requireStable?: boolean; [k: string]: unknown }
const settle = vb.settleCaptureConfig as undefined | ((cfg: Cfg, needles: readonly string[], boot?: readonly string[]) => Cfg)
const cockpit = vb.cockpitReadyText as undefined | ((cols: number, wide: number) => string[])
const needlesOf = vb.settleNeedles as undefined | ((cfg: Cfg, cockpit: readonly string[], extra?: readonly string[]) => string[])
const law = vb.SETTLE_LAW as undefined | { tickMs: number; stillTicks: number; ceilingTicks: number }

section('§1 the settle law is written once: every needle of the scene on screen, then still for 8 ticks; a 60 s ceiling')
check('the law exists beside the masks', law !== undefined && typeof settle === 'function' && typeof cockpit === 'function' && typeof needlesOf === 'function')
check('the stillness window is 8 ticks (1.6 s) and the ceiling 300 ticks (60 s) of 200 ms ticks', law !== undefined && law.tickMs === 200 && law.stillTicks === 8 && law.ceilingTicks === 300, JSON.stringify(law))
if (law && settle && cockpit && needlesOf) {
  const wide = cockpit(120, 100)
  const narrow = cockpit(60, 100)
  const both = (vb.cockpitReadyText as (cols: number, wide: number, both: number) => string[])(150, 100, 150)
  check('a wide cockpit is ready when the composer and the rail scan have landed', wide.join('|') === 'Type a prompt|RECENT|○ ', wide.join('|'))
  check('a narrow cockpit is ready when the composer and the late count row have landed (the host-neutral word of that row)', narrow.join('|') === 'Type a prompt|concourse', narrow.join('|'))
  check("a both-rails cockpit also waits for the workflow chip's idle measure, the last cell of the second rail", both.join('|') === 'Type a prompt|RECENT|○ |idle', both.join('|'))

  const frame = settle({ argv: ['node', 'x'], sends: [], total: 45, cols: 120, rows: 40 }, wide, wide)
  const chain = (frame.sends ?? []).map(s => s.awaitText)
  check('the wide frame waits on its own needles, one gate per needle, never a tick guess', chain.join('|') === wide.join('|') && (frame.sends ?? []).every(s => s.requireAwait === true && s.data === ''), JSON.stringify(frame.sends))
  check('the authored 45-tick budget becomes the ceiling and the still window becomes the end gate', frame.total === 300 && frame.stableTicks === 8 && frame.requireStable === true && frame.readyText === undefined, JSON.stringify({ total: frame.total, still: frame.stableTicks, req: frame.requireStable, ready: frame.readyText }))

  const help = settle({ argv: [], sends: [{ atTick: 30, data: '?' }], total: 46, cols: 120, rows: 40 }, needlesOf({}, wide, ['/keybindings to customize']), wide)
  const helpSends = help.sends ?? []
  const key = helpSends.find(s => s.data === '?')
  check('the help key is typed only into a cockpit whose needles have landed and held still — never blind at tick 30', key !== undefined && key.atTick === undefined && key.requireAwait === true && key.awaitText === '○ ' && key.awaitStableTicks === 8, JSON.stringify(key))
  check('the boot needles before the key are gates of their own, in order', helpSends.slice(0, 2).map(s => s.awaitText).join('|') === 'Type a prompt|RECENT', JSON.stringify(helpSends.slice(0, 2)))
  check("the help scene ends on the overlay's own row beside the cockpit needles", helpSends.slice(-1)[0]?.awaitText === '/keybindings to customize', JSON.stringify(helpSends.slice(-1)))

  const sessions = settle(
    { argv: [], sends: [{ atTick: 30, data: '/sessions' }, { atTick: 36, data: '\r' }], readyText: 'Switch to', stableTicks: 4, total: 100, cols: 120, rows: 40 },
    needlesOf({ readyText: 'Switch to' }, wide),
    wide,
  )
  const sSends = sessions.sends ?? []
  const enter = sSends.find(s => s.data === '\r')
  check("the sessions scene ends on the manager's own word, not the rail marks the manager hides", sSends.slice(-1)[0]?.awaitText === 'Switch to' && !sSends.slice(-1)[0]?.hasOwnProperty('atTick') && sessions.readyText === undefined, JSON.stringify(sSends.slice(-1)))
  check('the ↵ keeps its authored 6-tick gap after the command actually fired', enter !== undefined && enter.afterPrevTicks === 6 && enter.atTick === undefined, JSON.stringify(enter))
  check("the scene's own still window yields to the law's", sessions.stableTicks === 8 && sessions.total === 300)

  const own = needlesOf({ readyText: ['a', 'b'] }, wide, ['c'])
  check('a scene that names its own ready text keeps it (plus the extra), a scene without one takes the cockpit set', own.join('|') === 'a|b|c' && needlesOf({}, narrow).join('|') === narrow.join('|'), own.join('|'))
}

section('§2 a never-settled capture is refused at once — the doubling retry is gone')
check('no budget-doubling retry exists any more', vb.retryBudgetScale === undefined)
check('the refusal class and the settle kinds exist', typeof vb.CaptureRefusal === 'function' && typeof vb.isSettleRefusal === 'function')
{
  const isSettle = vb.isSettleRefusal as undefined | ((k: string) => boolean)
  check('never-ready, never-still and a wall kill are settle refusals; an oracle rejection is not', isSettle !== undefined && isSettle('never-ready') && isSettle('never-still') && isSettle('wall') && !isSettle('refused'))
}

section('§3 --jobs N: isolated homes, a claim queue in matrix order, results assembled by the parent')
const jobsPath = join(ROOT, 'scripts/lib/captureJobs.ts')
check('the jobs plumbing exists as one shared module', existsSync(jobsPath))
if (existsSync(jobsPath)) {
  const cj = (await import('../lib/captureJobs.ts')) as typeof import('../lib/captureJobs.ts')
  check('--jobs parses, -jN parses, the default is 1', cj.parseJobs(['--jobs', '4']) === 4 && cj.parseJobs(['-j6']) === 6 && cj.parseJobs([]) === 1)
  let threw = ''
  try {
    cj.parseJobs(['--jobs', '0'])
  } catch (e) {
    threw = String(e)
  }
  check('--jobs 0 is refused', threw.includes('--jobs'))
  check('the vshot slot count follows the jobs when they exceed the machine-wide default, and never shrinks it', cj.vshotSlotsFor(4, {}) === '4' && cj.vshotSlotsFor(1, {}) === '3' && cj.vshotSlotsFor(2, { VSHOT_SLOTS: '5' }) === '5')
  const dir = mkdtempSync(join(tmpdir(), 'capture-jobs-proof-'))
  try {
    const run = cj.openJobsRun(join(dir, 'run'))
    check('a job is claimed exactly once across workers', cj.claimJob(run, 'a--1') && !cj.claimJob(run, 'a--1') && cj.claimJob(run, 'b--2'))
    cj.writeJobResult(run, 'a--1', { ok: true, n: 1 })
    check('a result round-trips by id and a missing one reads null', JSON.stringify(cj.readJobResult(run, 'a--1')) === '{"ok":true,"n":1}' && cj.readJobResult(run, 'zzz') === null)
    check('every worker slot has a home of its own under the run', cj.workerHome(run, 1) !== cj.workerHome(run, 2) && cj.workerHome(run, 1).startsWith(run.dir))
    check('a refused capture has a place to keep what it saw, and the run reports it', cj.refusedDir(run, 'a--1').startsWith(run.refused) && cj.hasRefusals(run))
    cj.closeJobsRun(run, false)
    check('a closed run is removed', !existsSync(run.dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

section('§4 the three generators consume the law and the plumbing')
const gen = readFileSync(GENERATOR, 'utf8')
check('the grid generator takes --jobs, --out and a worker mode', gen.includes('parseJobs(') && gen.includes("'--out'") && gen.includes("'--worker'"))
check('the grid generator captures through the settle law and no longer overrides a scene with the rail marks', gen.includes('settleCaptureConfig(') && !gen.includes('stableTicks: 8 }'))
check('the grid generator never stretches a budget on retry', !gen.includes('MERCURY_VSHOT_BUDGET_SCALE: String('))
check('the grid generator keeps what a refused capture saw beside its log', gen.includes('last-frame.txt') && gen.includes('refusal.log'))
check('the grid generator still consumes the one capture-driver contract', gen.includes('resolveCaptureDriver('))
const contract = readFileSync(join(ROOT, 'scripts/visual-contract/baseline-capture.ts'), 'utf8')
check('the visual-contract generator takes --jobs and isolates every capture', contract.includes('parseJobs(') && contract.includes('--grid') && !contract.includes("`/tmp/grid-${cols}.json`"))
check('the visual-contract generator waits on the splash and the surfaces settling, not a 10-tick window', contract.includes('SETTLE_LAW') && !contract.includes('total: 10,'))
const interview = readFileSync(join(ROOT, 'scripts/interview/baseline-capture.ts'), 'utf8')
check('the interview generator takes --jobs and refuses an unsettled journey with what it saw', interview.includes('parseJobs(') && interview.includes('settledScreens(') )

const drive = process.argv.includes('--drive')
const identity = process.argv.includes('--identity')
if (drive || identity) {
  section(drive ? '§5 the three red grids under a load this proof makes: green, byte-identical to the quiet capture' : '§5 the full matrix at -j1 and -j4: byte-identical')
  const ready = gen.includes("'--out'") && gen.includes('settleCaptureConfig(')
  check('the drive runs only against a generator that takes --out (the base would write into the tree)', ready)
  if (ready) {
    const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
    const scratch = mkdtempSync(join(tmpdir(), 'capture-jobs-drive-'))
    const env = { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'home'), MERCURY_CREDENTIAL_STORE: 'file' }
    const generate = (out: string, jobs: number, only?: string): { status: number | null; log: string } => {
      const args = ['run', GENERATOR, '--jobs', String(jobs), '--out', out]
      if (only) args.push('--only', only)
      const r = spawnSync(bun, args, { cwd: ROOT, encoding: 'utf8', env, timeout: 1_800_000 })
      return { status: r.status, log: r.stdout + r.stderr }
    }
    const gridsOf = (out: string): Map<string, string> =>
      new Map(readdirSync(join(out, 'grids')).sort().map(f => [f, readFileSync(join(out, 'grids', f), 'utf8')]))
    const same = (a: string, b: string): string[] => {
      const ga = gridsOf(a)
      const gb = gridsOf(b)
      const diffs: string[] = []
      for (const [f, bytes] of ga) if (gb.get(f) !== bytes) diffs.push(f)
      for (const f of gb.keys()) if (!ga.has(f)) diffs.push(f)
      return diffs
    }
    try {
      if (drive) {
        const only = RED_GRIDS.join(',')
        const quiet = generate(join(scratch, 'quiet'), 1, only)
        check('the three grids capture on the quiet box at -j1', quiet.status === 0, quiet.log.split('\n').slice(-6).join(' · '))
        const busy = Number(process.env.CAPTURE_JOBS_LOAD ?? '400')
        const load = Array.from({ length: busy }, () => spawn('yes', [], { stdio: ['ignore', 'ignore', 'ignore'] }))
        const typechecks = [1, 2].map(() => spawn('bash', ['scripts/typecheck/run-all.sh'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], env }))
        try {
          await new Promise(r => setTimeout(r, 3000))
          const loaded = generate(join(scratch, 'loaded'), 3, only)
          const lines = loaded.log.split('\n')
          check(`under ${busy} busy processes and two typechecks the three grids settle green at -j3`, loaded.status === 0 && RED_GRIDS.every(id => lines.some(l => l === `✓ ${id}`)), lines.filter(l => l.startsWith('✗') || l.includes('never settled')).join(' · ').slice(0, 300))
          console.log(lines.filter(l => /^(entry|help--|frame--|sessions--)/.test(l)).map(l => '      ' + l).join('\n'))
          const diffs = same(join(scratch, 'quiet'), join(scratch, 'loaded'))
          const cockpitDiffs = diffs.filter(f => !f.startsWith('sessions--'))
          check('the loaded help and frame grids are byte-identical to the quiet ones', cockpitDiffs.length === 0, cockpitDiffs.join(', '))
          const sessionsDiff = diffs.find(f => f.startsWith('sessions--'))
          if (sessionsDiff === undefined) {
            check('the loaded sessions grid is byte-identical to the quiet one', true)
          } else {
            const quietGrid = JSON.parse(readFileSync(join(scratch, 'quiet', 'grids', sessionsDiff), 'utf8')) as { text: string[] }
            const loadedGrid = JSON.parse(readFileSync(join(scratch, 'loaded', 'grids', sessionsDiff), 'utf8')) as { text: string[] }
            const roster = loadedGrid.text.some(r => /Switch to \(\d+\)/.test(r) && !r.includes('Switch to (0)')) && quietGrid.text.some(r => r.includes('Switch to (0)'))
            const rows = loadedGrid.text.map((r, i) => (r !== quietGrid.text[i] ? `${i}: ${r.trimEnd()}` : '')).filter(Boolean).slice(0, 3)
            check("the loaded sessions grid differs from the quiet one only by the manager's roster — a stray recording beside the resumed session under extreme load, the product's race, not the capture's (named in the receipt)", roster, rows.join(' | '))
            if (roster) console.log(rows.map(r => '      ' + r).join('\n'))
          }
        } finally {
          for (const p of [...load, ...typechecks]) p.kill('SIGKILL')
        }
      }
      if (identity) {
        const one = generate(join(scratch, 'j1'), 1)
        check('the full matrix captures at -j1', one.status === 0, one.log.split('\n').slice(-3).join(' · '))
        const four = generate(join(scratch, 'j4'), 4)
        check('the full matrix captures at -j4', four.status === 0, four.log.split('\n').slice(-3).join(' · '))
        const diffs = same(join(scratch, 'j1'), join(scratch, 'j4'))
        check('every grid file is byte-identical between -j1 and -j4', diffs.length === 0, diffs.join(', '))
        const digests = (out: string): string => {
          const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { entries: Array<{ id: string; gridDigest: string; styleDigest: string }> }
          return m.entries.map(e => `${e.id} ${e.gridDigest} ${e.styleDigest}`).join('\n')
        }
        check("the manifests' digests are equal", digests(join(scratch, 'j1')) === digests(join(scratch, 'j4')))
        console.log(one.log.split('\n').filter(l => l.startsWith('settle law')).map(l => '      j1: ' + l).join('\n'))
        console.log(four.log.split('\n').filter(l => l.startsWith('settle law')).map(l => '      j4: ' + l).join('\n'))
      }
    } finally {
      if (!process.env.CAPTURE_JOBS_KEEP) rmSync(scratch, { recursive: true, force: true })
      else console.log(`  kept ${scratch}`)
    }
  }
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
