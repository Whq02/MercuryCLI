#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PLANNER = 'scripts/gate/ci-shard.sh'
const WORKFLOW = join(ROOT, '.github', 'workflows', 'drives.yml')
const SCRIPTS = join(ROOT, 'scripts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function classOf(runnerText: string): string {
  const m = /^# gate-class:\s*(\S+)/m.exec(runnerText)
  const c = m?.[1] ?? 'undeclared'
  return c === 'pure' || c === 'cpu' || c === 'pty' || c === 'exclusive' ? c : 'undeclared'
}

function plannerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k === 'MERCURY_SUITE_TIMEOUT' || k === 'MERCURY_SUITE_TIMEOUT_FLOOR' || k === 'MERCURY_SUITE_CEILING' || k.startsWith('MERCURY_CI_SHARD_')) delete env[k]
  }
  return { ...env, ...extra }
}

interface Row {
  suite: string
  seed: number | null
  ceiling: number
  budget: number
}

function runPlanner(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', [PLANNER, ...args], { cwd: ROOT, encoding: 'utf8', env })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function planTable(idx: string, total: number, cls: string, env: NodeJS.ProcessEnv): Row[] {
  const res = runPlanner([idx, String(total), '--class', cls, '--plan-table'], env)
  if (res.status !== 0) throw new Error(`planner exited ${String(res.status)} for shard ${idx}/${total} --class ${cls}: ${res.stderr.slice(0, 300)}`)
  return res.stdout
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(line => {
      const [suite, seed, ceiling, budget] = line.split('\t')
      if (!suite || seed === undefined || ceiling === undefined || budget === undefined) throw new Error(`malformed plan-table row: ${JSON.stringify(line)}`)
      return { suite, seed: seed === '-' ? null : Number(seed), ceiling: Number(ceiling), budget: Number(budget) }
    })
}

function planOnly(idx: string, total: number, cls: string, env: NodeJS.ProcessEnv): string[] {
  const res = runPlanner([idx, String(total), '--class', cls, '--plan-only'], env)
  if (res.status !== 0) throw new Error(`planner exited ${String(res.status)} for shard ${idx}/${total} --class ${cls}: ${res.stderr.slice(0, 300)}`)
  return res.stdout.split('\n').filter(l => l.trim() !== '')
}

console.log('§1 the drives ceiling rule (a synthetic estate through the hermetic seams)')
{
  const work = mkdtempSync(join(tmpdir(), 'drives-plan-'))
  const suite = (name: string, cls: string): void => {
    mkdirSync(join(work, 'suites', name), { recursive: true })
    writeFileSync(join(work, 'suites', name, 'run-all.sh'), `#!/usr/bin/env bash\n# gate-class: ${cls}\nexit 0\n`)
  }
  suite('long', 'pty')
  suite('granted', 'pty')
  suite('short', 'pty')
  suite('unseeded', 'pty')
  suite('quiet', 'pure')
  writeFileSync(join(work, 'seed.tsv'), 'long\t100\ngranted\t10\nshort\t2\nquiet\t100\n')
  writeFileSync(join(work, 'ceilings.tsv'), '# synthetic grants\ngranted\t50\n')
  const seams = {
    MERCURY_CI_SHARD_SUITES_DIR: join(work, 'suites'),
    MERCURY_CI_SHARD_SEED_FILE: join(work, 'seed.tsv'),
    MERCURY_CI_SHARD_CEILING_FILE: join(work, 'ceilings.tsv'),
    MERCURY_CI_SHARD_OUT: join(work, 'out'),
    MERCURY_SUITE_CEILING: '20',
  }
  try {
    const rows = planTable('0', 1, 'drives', plannerEnv(seams))
    const by = new Map(rows.map(r => [r.suite, r]))
    const pick = (s: string): Row => by.get(s) ?? { suite: s, seed: null, ceiling: -1, budget: -1 }
    check('the drives plan holds the four pty suites and not the pure one', [...by.keys()].sort().join(',') === 'granted,long,short,unseeded', [...by.keys()].join(','))
    check('an unlisted suite seeded 100 s gets a 200 s ceiling (twice its seed) and that ceiling as its budget', pick('long').seed === 100 && pick('long').ceiling === 200 && pick('long').budget === 200, JSON.stringify(pick('long')))
    check('a grant above twice the seed wins (seed 10, grant 50 → ceiling 50, budget 50)', pick('granted').ceiling === 50 && pick('granted').budget === 50, JSON.stringify(pick('granted')))
    check('the default wins when twice the seed is below it (seed 2, default 20 → ceiling 20, budget 20)', pick('short').ceiling === 20 && pick('short').budget === 20, JSON.stringify(pick('short')))
    check("a suite without a seed row reads '-' and gets the default", pick('unseeded').seed === null && pick('unseeded').ceiling === 20 && pick('unseeded').budget === 20, JSON.stringify(pick('unseeded')))
    const pinned = new Map(planTable('0', 1, 'drives', plannerEnv({ ...seams, MERCURY_SUITE_TIMEOUT: '30' })).map(r => [r.suite, r]))
    check(
      'an operator pin below a ceiling still wins (pin 30: long 30, granted 30) and never lifts one (short stays 20)',
      pinned.get('long')?.budget === 30 && pinned.get('granted')?.budget === 30 && pinned.get('short')?.budget === 20,
      [...pinned.values()].map(r => `${r.suite}:${r.budget}`).join(' '),
    )
    const whole = new Map(planTable('0', 1, 'all', plannerEnv(seams)).map(r => [r.suite, r]))
    check(
      'the whole-estate plan keeps the classic law: the seed lifts no ceiling there (long → ceiling 20, budget 20) and the pure suite is planned',
      whole.get('long')?.ceiling === 20 && whole.get('long')?.budget === 20 && whole.get('quiet') !== undefined,
      [...whole.values()].map(r => `${r.suite}:${r.ceiling}/${r.budget}`).join(' '),
    )
    const bare = planOnly('0', 1, 'drives', plannerEnv(seams))
    check('--plan-only keeps its bare-name shape (no tabs; the same four suites)', bare.every(l => !l.includes('\t')) && [...bare].sort().join(',') === 'granted,long,short,unseeded', bare.join(' '))
    check('--plan-table writes no output directory (a plan is never a run)', !existsSync(join(work, 'out')))
  } catch (error) {
    check('the planner answered on the synthetic estate', false, String(error).slice(0, 400))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

console.log('\n§2 the real drives plan')
{
  const wf = readFileSync(WORKFLOW, 'utf8')
  const total = Number(/ci-shard\.sh "\$\{\{ matrix\.shard \}\}" (\d+) --class drives/.exec(wf)?.[1] ?? Number.NaN)
  const matrix = (/^\s*shard: \[([^\]]*)\]/m.exec(wf)?.[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
  check('the workflow names its shard count and its matrix lists exactly that many shards', Number.isFinite(total) && total > 0 && matrix.length === total, `count ${total}, matrix [${matrix.join(', ')}]`)
  const shardStart = wf.indexOf('\n  shard:\n')
  const shardEnd = wf.indexOf('\n  darwin:\n')
  const shardJob = shardStart >= 0 && shardEnd > shardStart ? wf.slice(shardStart, shardEnd) : ''
  const windowMin = Number(/timeout-minutes: (\d+)/.exec(shardJob)?.[1] ?? Number.NaN)
  check('the shard job declares its window (timeout-minutes)', Number.isFinite(windowMin) && windowMin > 0, 'the shard job block or its timeout-minutes line was not found')
  check('the workflow pins no flat per-suite budget (MERCURY_SUITE_TIMEOUT); every suite runs under its own ceiling', !/^\s*MERCURY_SUITE_TIMEOUT:/m.test(wf))
  const windowS = windowMin * 60

  const pty: string[] = []
  for (const d of readdirSync(SCRIPTS).sort()) {
    const runner = join(SCRIPTS, d, 'run-all.sh')
    if (!existsSync(runner)) continue
    if (classOf(readFileSync(runner, 'utf8')) === 'pty') pty.push(d)
  }
  const darwinList = new Set<string>()
  const darwinFile = join(SCRIPTS, 'gate', 'ci-darwin-suites.txt')
  if (existsSync(darwinFile)) {
    for (const raw of readFileSync(darwinFile, 'utf8').split('\n')) {
      const line = raw.split('#')[0]!.trim()
      if (line !== '') darwinList.add(line)
    }
  }

  if (Number.isFinite(total) && total > 0 && Number.isFinite(windowMin)) {
    try {
      const env = plannerEnv()
      const buckets: Row[][] = []
      for (let k = 0; k < total; k++) buckets.push(planTable(String(k), total, 'drives', env))
      const darwin = planOnly('darwin', total, 'drives', env)
      const planned = new Map<string, number>()
      const bump = (s: string): void => {
        planned.set(s, (planned.get(s) ?? 0) + 1)
      }
      for (const b of buckets) for (const r of b) bump(r.suite)
      for (const s of darwin) bump(s)
      const missing = pty.filter(s => !planned.has(s))
      const twice = [...planned].filter(([, n]) => n > 1).map(([s, n]) => `${s}×${n}`)
      const foreign = [...planned.keys()].filter(s => !pty.includes(s))
      check(
        `every pty suite is planned exactly once across ${total} shards and the darwin lane (${pty.length} suites)`,
        missing.length === 0 && twice.length === 0,
        `missing: ${missing.join(' ') || 'none'}; planned twice: ${twice.join(' ') || 'none'}`,
      )
      check('no suite outside the pty class is in the drives plan', foreign.length === 0, foreign.join(' '))
      const strayDarwin = darwin.filter(s => !darwinList.has(s))
      check('the darwin lane holds only suites the straggler list names', strayDarwin.length === 0, strayDarwin.join(' '))
      const thin = buckets.flat().filter(r => r.budget < 2 * (r.seed ?? 30))
      check("every planned suite's budget is at least twice its seeded wall (the drives ceiling rule)", thin.length === 0, thin.map(r => `${r.suite} seed ${String(r.seed)} budget ${r.budget}`).join('; '))
      const unseeded = buckets
        .flat()
        .filter(r => r.seed === null)
        .map(r => r.suite)
      if (unseeded.length > 0) console.log(`  info: planned without a seed row (balanced at the 30 s default; the scheduler prover owns the seed-row law): ${unseeded.join(' ')}`)
      let worstSeed = 0
      let worstBudget = 0
      buckets.forEach((b, k) => {
        const seedSum = b.reduce((n, r) => n + (r.seed ?? 30), 0)
        const budgetSum = b.reduce((n, r) => n + r.budget, 0)
        worstSeed = Math.max(worstSeed, seedSum)
        worstBudget = Math.max(worstBudget, budgetSum)
        console.log(`  shard ${k}: ${b.length} suites · seeded ${seedSum} s · ceilings ${budgetSum} s — ${b.map(r => `${r.suite}(${r.seed ?? '-'}/${r.budget})`).join(' ')}`)
      })
      console.log(`  darwin: ${darwin.length > 0 ? darwin.join(' ') : 'none'}`)
      check(`every bucket's seeded walls fit the ${windowMin}-minute shard window (largest ${worstSeed} s of ${windowS})`, worstSeed <= windowS)
      check(`every bucket's ceilings summed fit the shard window — a bucket that wedges end to end still reports (largest ${worstBudget} s of ${windowS})`, worstBudget <= windowS)
    } catch (error) {
      check('the planner answered for every shard of the real estate', false, String(error).slice(0, 400))
    }
  }
}

console.log('\n§3 the journey split')
{
  const parentDir = join(SCRIPTS, 'journey')
  const parentText = readFileSync(join(parentDir, 'run-all.sh'), 'utf8')
  const provers = readdirSync(parentDir)
    .filter(f => /^prove-.*\.ts$/.test(f))
    .sort()
  const siblings = readdirSync(SCRIPTS)
    .filter(d => /^journey-\d+$/.test(d) && existsSync(join(SCRIPTS, d, 'members.txt')) && existsSync(join(SCRIPTS, d, 'run-all.sh')))
    .sort((a, b) => Number(a.slice('journey-'.length)) - Number(b.slice('journey-'.length)))
  check('the journey estate has sibling suites with member lists', siblings.length > 0)
  check(
    'the parent runs the complement of the sibling lists, stays glob-driven, and keeps the double-claim law',
    parentText.includes('cat scripts/journey-*/members.txt') && parentText.includes('prove-*.ts') && parentText.includes('uniq -d'),
  )
  const claims = new Map<string, string[]>()
  const bad: string[] = []
  for (const s of siblings) {
    const runner = readFileSync(join(SCRIPTS, s, 'run-all.sh'), 'utf8')
    if (classOf(runner) !== 'pty') bad.push(`${s}: not declared pty`)
    if (!runner.includes('scripts/journey/$name')) bad.push(`${s}: does not read the members from the parent's directory`)
    if (runner.includes('prove-*.ts')) bad.push(`${s}: names the parent's glob (the membership law would read the runner as glob-driven)`)
    const names = readFileSync(join(SCRIPTS, s, 'members.txt'), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.startsWith('#'))
    if (names.length === 0) bad.push(`${s}: an empty member list`)
    for (const n of names) {
      if (!provers.includes(n)) bad.push(`${s}: ${n} is not a prover in scripts/journey/`)
      claims.set(n, [...(claims.get(n) ?? []), s])
    }
  }
  const twice = [...claims].filter(([, by]) => by.length > 1).map(([n, by]) => `${n} (${by.join(', ')})`)
  check(`every sibling list names existing journey provers, is non-empty, is pty, and reads the parent's directory (${siblings.length} siblings)`, bad.length === 0, bad.join('; '))
  check('no journey prover is claimed by two sibling lists', twice.length === 0, twice.join('; '))
  const complement = provers.filter(p => !claims.has(p))
  console.log(`  journey: ${complement.length} provers in the complement · ${claims.size} across ${siblings.length} sibling suites (${siblings.map(s => `${s}:${[...claims.values()].filter(by => by.includes(s)).length}`).join(' ')})`)
  check('the complement is not empty (the parent still runs a proof)', complement.length > 0)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-drives-plan — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
