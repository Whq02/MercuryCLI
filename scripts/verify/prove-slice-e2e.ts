#!/usr/bin/env bun

import { execSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const scratch = mkdtempSync(join(tmpdir(), 'slice-e2e-'))
const sh = (cmd: string): string =>
  execSync(cmd, { cwd: scratch, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })

function mkSuite(dom: string, headers: string[], body: string): void {
  const dir = join(scratch, 'scripts', dom)
  mkdirSync(dir, { recursive: true })
  const runner = join(dir, 'run-all.sh')
  writeFileSync(runner, ['#!/usr/bin/env bash', ...headers, body, ''].join('\n'))
  chmodSync(runner, 0o755)
}

interface FastResult {
  status: number | null
  out: string
}
function fast(args: string[], env: Record<string, string> = {}): FastResult {
  const r = spawnSync(process.execPath, ['run', join(REPO, 'scripts/verify/fast.ts'), ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      MERCURY_SLICE_ROOT: scratch,
      MERCURY_SLICE_NO_CI: '1',
      MERCURY_SLICE_CORES: '8',
      MERCURY_GATE_NO_PREBUILD: '1',
      MERCURY_CONFIG_DIR: join(scratch, 'config-home'),
      MERCURY_HOME: join(scratch, 'proof-home'),
      BROWSER: '/usr/bin/true',
      ...env,
    },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function markers(): string[] {
  try {
    return execSync(`ls ${join(scratch, 'markers')}`, { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  } catch {
    return []
  }
}
function resetMarkers(): void {
  rmSync(join(scratch, 'markers'), { recursive: true, force: true })
  mkdirSync(join(scratch, 'markers'), { recursive: true })
}

function evidenceRecords(): Array<{ scope: string; coverage: string; ok: boolean }> {
  const candidates: string[] = []
  try {
    const verifyRoot = join(scratch, 'config-home', 'verify')
    for (const entry of readdirSync(verifyRoot)) candidates.push(join(verifyRoot, entry, 'evidence.json'))
  } catch {  }
  for (const home of ['.claude', '.mercury']) {
    candidates.push(join(scratch, home, 'verify', 'evidence.json'))
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return (JSON.parse(readFileSync(p, 'utf8')).records ?? []) as Array<{ scope: string; coverage: string; ok: boolean }>
      } catch {
        return []
      }
    }
  }
  return []
}

const marker = (dom: string): string => `mkdir -p '${join(scratch, 'markers')}'; echo ran >>'${join(scratch, 'markers', dom)}'; exit 0`
mkSuite('typecheck', ['# gate-class: pure'], 'exit 0')
mkSuite('alpha', ['# gate-class: pure', '# gate-watch: lib/alpha/** lib/wide.txt'], marker('alpha'))
mkSuite('beta', ['# gate-class: pure', '# gate-watch: lib/beta/** lib/wide.txt'], marker('beta'))
mkSuite('gamma', ['# gate-class: pure', '# gate-watch: lib/wide.txt'], marker('gamma'))
mkSuite('omega', ['# gate-class: pure'], marker('omega'))

mkdirSync(join(scratch, 'scripts', 'gate'), { recursive: true })
cpSync(join(REPO, 'scripts/run-all-suites.sh'), join(scratch, 'scripts/run-all-suites.sh'))
cpSync(join(REPO, 'scripts/gate/run-suite.sh'), join(scratch, 'scripts/gate/run-suite.sh'))
writeFileSync(
  join(scratch, 'scripts/gate/duration-seed.tsv'),
  'alpha\t5\nbeta\t5\ngamma\t5\ntypecheck\t5\nomega\t300\n',
)
writeFileSync(join(scratch, 'scripts/gate/impact-ignore.txt'), 'docs/**\n*.md\n**/*.md\n')

mkdirSync(join(scratch, 'lib', 'alpha'), { recursive: true })
mkdirSync(join(scratch, 'lib', 'beta'), { recursive: true })
mkdirSync(join(scratch, 'docs'), { recursive: true })
writeFileSync(join(scratch, 'lib/alpha/a.txt'), 'alpha v1\n')
writeFileSync(join(scratch, 'lib/beta/b.txt'), 'beta v1\n')
writeFileSync(join(scratch, 'lib/wide.txt'), 'wide v1\n')
writeFileSync(join(scratch, 'docs/readme.md'), 'ignored\n')
writeFileSync(join(scratch, '.gitignore'), '.claude/\n.mercury/\nmarkers/\nconfig-home/\nproof-home/\n')

sh('git init -q')
sh('git config user.email slice-e2e@proof.local && git config user.name slice-e2e')
sh('git add -A && git commit -qm fixture')
const headSha = sh('git rev-parse HEAD').trim()
const headTree = sh('git rev-parse HEAD^{tree}').trim()

function writeVerdict(): void {
  mkdirSync(join(scratch, '.mercury', 'gate'), { recursive: true })
  writeFileSync(
    join(scratch, '.mercury/gate/verdict.json'),
    JSON.stringify(
      {
        ok: true,
        pass: ['alpha', 'beta', 'gamma', 'typecheck', 'omega'],
        fail: [],
        ranAt: '2026-07-25T00:00:00Z',
        headSha,
        dirty: false,
        treeSha: headTree,
        durationS: 320,
        durations: { alpha: 5, beta: 5, gamma: 5, typecheck: 5, omega: 300 },
        classes: { alpha: 'pure', beta: 'pure', gamma: 'pure', typecheck: 'pure', omega: 'pure' },
        flakes: [],
      },
      null,
      2,
    ),
  )
}
writeVerdict()
resetMarkers()

try {
  section('A — clean tree at the anchor: floors only, 0 suites')
  {
    const r = fast([])
    check('exit 0', r.status === 0, `status=${r.status}`)
    check('base line names the local verdict', r.out.includes('base: last full-green tree (local verdict)'))
    check('anchor age 0 printed', r.out.includes('anchor age: 0 commit(s)'), r.out.split('\n').find(l => l.includes('anchor age')) ?? '')
    check('no suites executed (no markers)', markers().length === 0, markers().join(','))
    const rows = evidenceRecords()
    const last = rows.at(-1)
    check(
      "evidence row: scope 'fast', zero suites NAMED as such",
      last?.scope === 'fast' && last.ok === true && last.coverage.includes('no suites selected'),
      JSON.stringify(last),
    )
  }

  section('B — dirty lib/alpha/a.txt: plan RUN [alpha]; pooled run executes exactly alpha')
  {
    appendFileSync(join(scratch, 'lib/alpha/a.txt'), 'dirt\n')
    const plan = fast(['--plan'])
    check('plan exits 0', plan.status === 0, `status=${plan.status}`)
    check('plan verdict RUN suites [alpha]', plan.out.includes('plan verdict: RUN suites [alpha]'), plan.out.split('\n').find(l => l.includes('plan verdict')) ?? '')
    check('plan executes nothing', !plan.out.includes('━━ ') && markers().length === 0)

    const r = fast([])
    check('run exits 0', r.status === 0, `status=${r.status}`)
    check('the pooled subset ran through the REAL gate runner', r.out.includes('pooled suites [alpha]') && /ALL 1 SUITES GREEN/.test(r.out), r.out.slice(-400))
    check('exactly alpha executed', markers().join(',') === 'alpha', markers().join(','))
    const last = evidenceRecords().at(-1)
    check(
      "evidence row NAMES the suite (scope 'fast')",
      last?.scope === 'fast' && last.ok === true && last.coverage.includes('suites [alpha]'),
      JSON.stringify(last),
    )
  }

  section('C — a committed change + new dirt: age 1 commit, suites [alpha, beta]')
  {
    sh('git add -A && git commit -qm change-alpha')
    appendFileSync(join(scratch, 'lib/beta/b.txt'), 'dirt\n')
    resetMarkers()
    const r = fast([])
    check('exit 0', r.status === 0, `status=${r.status}`)
    check('anchor age 1 commit printed', r.out.includes('anchor age: 1 commit(s)'), r.out.split('\n').find(l => l.includes('anchor age')) ?? '')
    check('both suites executed', markers().join(',') === 'alpha,beta', markers().join(','))
    check('the subset line names both', r.out.includes('pooled suites [alpha, beta]'))
  }

  section('D — ratio pinned tiny: REFUSE, exit 2, zero execution, zero evidence')
  {
    resetMarkers()
    const before = evidenceRecords().length
    const r = fast([], { MERCURY_SLICE_RATIO: '0.01' })
    check('exit 2 (refusal, distinct from a RED run)', r.status === 2, `status=${r.status}`)
    check('names the not-faster law', r.out.includes('REFUSED (not-faster)'), r.out.split('\n').find(l => l.includes('REFUSED')) ?? '')
    check('names "run the full pool"', r.out.includes('run the full pool'))
    check('nothing executed', markers().length === 0 && !r.out.includes('━━ '), markers().join(','))
    check('no evidence row recorded (nothing was verified)', evidenceRecords().length === before)
  }

  section('F — an unclassified path: --plan names ESCALATE(unclassified), runs nothing')
  {
    writeFileSync(join(scratch, 'mystery.bin'), 'unclaimed\n')
    const r = fast(['--plan'])
    check('plan exits 0', r.status === 0, `status=${r.status}`)
    check('plan verdict ESCALATE(unclassified)', r.out.includes('ESCALATE to the FULL gate (unclassified)'), r.out.split('\n').find(l => l.includes('plan verdict')) ?? '')
    check('nothing executed', markers().length === 0)
    rmSync(join(scratch, 'mystery.bin'))
  }

  section('E — hub over the pinned ceiling: FULL gate auto-runs, truthful full-gate row')
  {
    appendFileSync(join(scratch, 'lib/wide.txt'), 'dirt\n')
    resetMarkers()
    const r = fast([], { MERCURY_SLICE_HUB_CEILING: '2' })
    check('exit 0 (the full gate ran green)', r.status === 0, `status=${r.status}`)
    check('names the hub path + fan-out', r.out.includes('hub fan-out: lib/wide.txt') && r.out.includes('3 suites'), r.out.split('\n').find(l => l.includes('hub fan-out')) ?? '')
    check('the FULL estate executed (every marker)', markers().join(',') === 'alpha,beta,gamma,omega', markers().join(','))
    check('the full run reported all 5 suites', /ALL 5 SUITES GREEN/.test(r.out), r.out.slice(-300))
    const last = evidenceRecords().at(-1)
    check(
      "evidence row: scope 'full-gate' naming the escalation (a slice green never masquerades)",
      last?.scope === 'full-gate' && last.ok === true && last.coverage.includes('escalated from verify:fast') && last.coverage.includes('hub'),
      JSON.stringify(last),
    )
    sh('git checkout -- lib/wide.txt')
  }

  section('G — no verdict: the run REFUSES naming the pool; --plan honest at exit 0')
  {
    rmSync(join(scratch, '.mercury/gate/verdict.json'))
    resetMarkers()
    const run = fast([])
    check('run exits 2', run.status === 2, `status=${run.status}`)
    check('names the anchor refusal + the pool', run.out.includes('REFUSED (anchor-absent)') && run.out.includes('run the full pool'))
    check('nothing executed', markers().length === 0)
    const plan = fast(['--plan'])
    check('plan exits 0 with the honest base: NONE line', plan.status === 0 && plan.out.includes('base: NONE'), `status=${plan.status}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) {
  console.log(' ✅ SLICE E2E GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SLICE-E2E FAILURE(S)`)
process.exit(1)
