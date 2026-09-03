#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { adoptiveProjectPath } from '../../src/utils/projectStoreAdoption.js'
import { isAdvisoryKind, readLedger } from '../gate/ledger.js'
import { spawnSync } from 'node:child_process'
import { gitOutOrNull } from '../lib/git.ts'
import { fullPoolSupport, resolveExecutionProfile } from '../lib/executionProfile.ts'
import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { loadImpactManifest } from './impactManifest.ts'
import {
  DEFAULT_CLEARLY_UNDER_RATIO,
  DEFAULT_HUB_CEILING,
  planSlice,
  type GateClass,
  type SliceAnchor,
} from './sliceCore.ts'

const ROOT = process.env.MERCURY_SLICE_ROOT
  ? resolve(process.env.MERCURY_SLICE_ROOT)
  : resolve(import.meta.dir, '..', '..')
const PLAN_ONLY = process.argv.includes('--plan')

const anchorMisses: string[] = []
function gitOut(args: string[]): string | null {
  return gitOutOrNull(args, {
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
    onMiss: miss =>
      anchorMisses.push(
        `git ${args.join(' ')} → ${miss.state}${miss.state === 'nonzero' ? ` (${miss.code})` : miss.state === 'unavailable' ? ` (${miss.detail})` : ''}`,
      ),
  })
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

function dirtyPaths(): string[] {
  return (gitOut(['status', '--porcelain']) ?? '')
    .split('\n')
    .map(l => l.slice(3).trim())
    .filter(Boolean)
    .map(l => (l.includes(' -> ') ? l.split(' -> ')[1]! : l))
}

function localGreenTree(): { tree: string; headSha: string | null } | null {
  try {
    const v = JSON.parse(readFileSync(join(adoptiveProjectPath(ROOT, 'gate'), 'verdict.json'), 'utf8'))
    if (v?.ok !== true || typeof v?.treeSha !== 'string') return null
    const kind = gitOut(['cat-file', '-t', v.treeSha])?.trim()
    if (kind !== 'tree') return null
    const headSha =
      typeof v?.headSha === 'string' && /^[0-9a-f]{40}$/.test(v.headSha) ? v.headSha : null
    return { tree: v.treeSha, headSha }
  } catch {
    return null
  }
}

function ledgerGreenTrees(): Array<{ tree: string; headSha: string; kind: string }> {
  try {
    const rows = readLedger().filter(r => r.ok && !isAdvisoryKind(r.kind))
    const out: Array<{ tree: string; headSha: string; kind: string }> = []
    for (const row of rows.slice(-20)) {
      if (!/^[0-9a-f]{40}$/.test(row.commit)) continue
      const anc = spawnSync('git', ['merge-base', '--is-ancestor', row.commit, 'HEAD'], { cwd: ROOT })
      if (anc.status !== 0) continue
      const tree = gitOut(['rev-parse', `${row.commit}^{tree}`])?.trim() ?? null
      if (tree !== null && /^[0-9a-f]{40}$/.test(tree)) out.push({ tree, headSha: row.commit, kind: row.kind })
    }
    return out
  } catch {
    return []
  }
}

function ciGreenTrees(): Array<{ tree: string; headSha: string }> {
  if (process.env.MERCURY_SLICE_NO_CI === '1') return []
  const r = spawnSync(
    'gh',
    ['run', 'list', '--workflow', 'gate.yml', '--branch', 'main', '--status', 'success', '--limit', '5', '--json', 'headSha'],
    { cwd: ROOT, encoding: 'utf8', timeout: 8000 },
  )
  if (r.status !== 0 || !r.stdout) return []
  try {
    const runs = JSON.parse(r.stdout) as Array<{ headSha?: string }>
    const trees: Array<{ tree: string; headSha: string }> = []
    for (const run of runs) {
      const sha = run.headSha
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue
      const anc = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT })
      if (anc.status !== 0) continue
      const tree = gitOut(['rev-parse', `${sha}^{tree}`])?.trim() ?? null
      if (tree !== null && /^[0-9a-f]{40}$/.test(tree)) trees.push({ tree, headSha: sha })
    }
    return trees
  } catch {
    return []
  }
}

const dirty = dirtyPaths()
const changedFrom = (tree: string): string[] =>
  (gitOut(['diff', '--name-only', tree, 'HEAD']) ?? '').split('\n').map(l => l.trim()).filter(Boolean)

interface AnchorCandidate {
  tree: string
  source: string
  headSha: string | null
  changed: string[]
}
const candidates: AnchorCandidate[] = []
const local = localGreenTree()
if (local) {
  candidates.push({ tree: local.tree, source: 'local verdict', headSha: local.headSha, changed: changedFrom(local.tree) })
}
const fromLedger = ledgerGreenTrees()
for (const row of fromLedger) {
  if (candidates.some(c => c.tree === row.tree)) continue
  candidates.push({
    tree: row.tree,
    source: `gate ledger (${row.kind})`,
    headSha: row.headSha,
    changed: changedFrom(row.tree),
  })
}
if (candidates.every(c => c.changed.length > 0)) {
  for (const ci of ciGreenTrees()) {
    if (ci.tree === local?.tree) continue
    if (candidates.some(c => c.tree === ci.tree)) continue
    candidates.push({ tree: ci.tree, source: 'ci verdict', headSha: ci.headSha, changed: changedFrom(ci.tree) })
  }
}
candidates.sort((a, b) => a.changed.length - b.changed.length)
const base = candidates[0] ?? null

const anchor: SliceAnchor | null = base
  ? {
      treeSha: base.tree,
      source: base.source,
      headSha: base.headSha,
      ageCommits: (() => {
        if (!base.headSha) return null
        const n = gitOut(['rev-list', '--count', `${base.headSha}..HEAD`])?.trim() ?? null
        return n !== null && /^\d+$/.test(n) ? Number.parseInt(n, 10) : null
      })(),
    }
  : null

const paths = base ? [...new Set([...base.changed, ...dirty])] : [...new Set(dirty)]

console.log('verify:fast — declared-impact targeted verification (the slice rung)')
console.log(
  base
    ? `  base: last full-green tree (${base.source}) ${base.tree.slice(0, 12)}… + working dirt → ${paths.length} changed path(s)`
    : `  base: NONE — no full-green verdict tree available (run the full pool to anchor) → ${dirty.length} dirty path(s) unanchored`,
)
if (anchor) {
  console.log(
    `  anchor age: ${anchor.ageCommits === null ? 'unknown (verdict head unrecorded)' : `${anchor.ageCommits} commit(s)`}` +
      `${anchor.headSha ? ` since ${anchor.headSha.slice(0, 12)}` : ''}${dirty.length > 0 ? ` · +${dirty.length} dirty path(s)` : ''}`,
  )
}

const manifest = loadImpactManifest(ROOT)

function loadDurations(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const seed = readFileSync(join(ROOT, 'scripts/gate/duration-seed.tsv'), 'utf8')
    for (const line of seed.split('\n')) {
      const m = line.match(/^([A-Za-z0-9-]+)\t(\d+)$/)
      if (m) out[m[1]!] = Number.parseInt(m[2]!, 10)
    }
  } catch {
  }
  try {
    const v = JSON.parse(readFileSync(join(adoptiveProjectPath(ROOT, 'gate'), 'verdict.json'), 'utf8'))
    if (v?.durations && typeof v.durations === 'object') {
      for (const [k, s] of Object.entries(v.durations as Record<string, unknown>)) {
        if (typeof s === 'number' && Number.isFinite(s)) out[k] = s
      }
    }
  } catch {
  }
  return out
}

const plan = planSlice({
  changedPaths: paths,
  manifest,
  classes: (manifest.classes ?? {}) as Record<string, GateClass>,
  durations: loadDurations(),
  anchor,
  cores: envInt('MERCURY_SLICE_CORES', Math.max(2, cpus().length)),
  ptyMax: envInt('MERCURY_GATE_PTY_MAX', 3),
  hubCeiling: envInt('MERCURY_SLICE_HUB_CEILING', DEFAULT_HUB_CEILING),
  clearlyUnderRatio: envFloat('MERCURY_SLICE_RATIO', DEFAULT_CLEARLY_UNDER_RATIO),
})

const selection = plan.ledger.selection
let runtimeChanged = false
let buildFacing = false
for (const p of paths) {
  if (/^src\//.test(p)) runtimeChanged = true
  if (/^build\.ts$|^src\/utils\/ripgrep|^package\.json$/.test(p)) buildFacing = true
}

if (anchorMisses.length > 0) {
  console.log(`  anchor-resolution misses: ${anchorMisses.length} (git call(s) failed — NOT proof that no anchor exists)`)
  for (const m of anchorMisses.slice(0, 8)) console.log(`      ${m}`)
}
if (selection && selection.ignored.length > 0)
  console.log(`  ignored (declared no-runtime-surface): ${selection.ignored.length} path(s)`)
if (plan.ledger.suites.length > 0)
  console.log(`  affected suites: ${plan.ledger.suites.join(', ')}`)
if (plan.ledger.sliceEstimateS !== null) {
  const pct = Math.round((plan.ledger.sliceEstimateS / Math.max(1, plan.ledger.poolEstimateS)) * 100)
  console.log(
    `  estimate: slice ≈ ${plan.ledger.sliceEstimateS}s pooled vs full pool ≈ ${plan.ledger.poolEstimateS}s (${pct}%)`,
  )
} else {
  console.log(`  estimate: full pool ≈ ${plan.ledger.poolEstimateS}s (no slice wall — ${plan.kind})`)
}

if (PLAN_ONLY) {
  if (selection) {
    for (const [p, who] of Object.entries(selection.perPath)) console.log(`    ${p} → ${who.join(', ')}`)
  }
  const verdict =
    plan.kind === 'run'
      ? `RUN${plan.suites.length > 0 ? ` suites [${plan.suites.join(', ')}]` : ' (floors only)'}`
      : plan.kind === 'refuse'
        ? `REFUSE (${plan.reason}): ${plan.message}`
        : `ESCALATE to the FULL gate (${plan.reason}): ${plan.message}`
  console.log(
    `  plan: warm typecheck${runtimeChanged ? ' + build' : ''}${buildFacing ? ' + artifact smoke' : ''}` +
      `${plan.ledger.suites.length > 0 ? ` + pooled suites [${plan.ledger.suites.join(', ')}]` : ''}`,
  )
  console.log(`  plan verdict: ${verdict}`)
  process.exit(0)
}

async function recordRow(ok: boolean, scope: 'fast' | 'full-gate', coverage: string): Promise<void> {
  try {
    const { recordEvidence, verifyEvidenceEnabled } = await import(
      '../../src/utils/verification/verificationState.js'
    )
    if (!verifyEvidenceEnabled()) return
    recordEvidence(ROOT, { command: 'bun run verify:fast', ok, scope, coverage })
  } catch {
    console.log('  (evidence record skipped — verification store unavailable)')
  }
}

if (plan.kind === 'refuse') {
  console.log(`\n  ✋ REFUSED (${plan.reason}): ${plan.message}`)
  process.exit(2)
}

if (plan.kind === 'escalate') {
  if (plan.reason === 'unclassified' && selection) {
    console.log('\n  ⚠ UNCLASSIFIED changed path(s) — no suite watches these, and they are not declared ignorable:')
    for (const p of selection.unclassified.slice(0, 20)) console.log(`      ${p}`)
    console.log('  Declare a `# gate-watch:` (or an impact-ignore row) — ESCALATING to the FULL gate now.')
  } else {
    console.log(`\n  ⚠ ${plan.message}`)
    console.log('  ESCALATING to the FULL gate now (a full run also re-anchors the slice rung).')
  }
  const support = fullPoolSupport(resolveExecutionProfile(ROOT))
  if (!support.supported) {
    console.log(`\n  ✋ full-pool escalation REFUSED before any spawn: ${support.reason}`)
    console.log(`     ${support.remedy}`)
    await recordRow(false, 'full-gate', `escalation refused before spawn (${support.reason})`)
    process.exit(3)
  }
  const r = spawnSync('bash', ['scripts/run-all-suites.sh'], { cwd: ROOT, stdio: 'inherit' })
  const ok = r.status === 0
  await recordRow(
    ok,
    'full-gate',
    `full gate (escalated from verify:fast — ${plan.reason === 'hub-fanout' ? plan.message.split(' — ')[0] : `${selection?.unclassified.length ?? 0} unclassified path(s)`})`,
  )
  process.exit(r.status ?? 1)
}

interface StepResult {
  label: string
  ok: boolean
  seconds: number
}

function run(label: string, cmd: string, args: string[], timeoutMs: number, env?: Record<string, string>): StepResult {
  console.log(`\n━━ ${label} ━━ (${[cmd, ...args].join(' ')})`)
  const t0 = Date.now()
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: timeoutMs,
    env: env ? { ...process.env, ...env } : process.env,
  })
  const seconds = Math.round((Date.now() - t0) / 1000)
  const ok = r.status === 0
  console.log(`── ${label}: ${ok ? 'GREEN' : `RED (exit ${r.status})`} in ${seconds}s`)
  return { label, ok, seconds }
}

const bunBin = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
const steps: StepResult[] = []

if (existsSync(join(ROOT, 'scripts/typecheck/run-all.sh'))) {
  steps.push(run('typecheck floor (warm incremental)', 'bash', ['scripts/typecheck/run-all.sh', '--warm'], 10 * 60_000))
} else {
  console.log('  (no scripts/typecheck/run-all.sh at this root — typecheck floor skipped)')
}

let distEnsured = false
if ((plan.suites.length > 0 || runtimeChanged) && existsSync(join(ROOT, 'build.ts')) && steps.every(s => s.ok)) {
  const cache = spawnSync('bash', ['scripts/gate/dist-cache-check.sh'], { cwd: ROOT, encoding: 'utf8' })
  const cacheLine = (cache.stdout ?? '').trim()
  if (cache.status === 0 && cacheLine.startsWith('HIT ')) {
    console.log(`  ⚙  dist cache HIT (content tree ${cacheLine.slice(4, 16)}…) — rebuild skipped`)
    distEnsured = true
  } else {
    steps.push(run('real artifact build', bunBin, ['run', 'build.ts'], 8 * 60_000))
    distEnsured = steps.at(-1)!.ok
  }
}
if (buildFacing && existsSync(join(ROOT, 'scripts/build/prove-isolated-artifact.ts')) && steps.every(s => s.ok)) {
  steps.push(run('isolated artifact smoke', bunBin, ['run', 'scripts/build/prove-isolated-artifact.ts'], 5 * 60_000))
}

if (plan.suites.length > 0 && steps.every(s => s.ok)) {
  const poolSupport = fullPoolSupport(resolveExecutionProfile(ROOT))
  if (!poolSupport.supported) {
    console.log(`\n  ✋ pooled-suite rung REFUSED before any spawn: ${poolSupport.reason}`)
    console.log(`     ${poolSupport.remedy}`)
    steps.push({ label: `pooled suites [${plan.suites.join(', ')}] — refused (${poolSupport.reason})`, ok: false, seconds: 0 })
  } else {
    steps.push(
      run(
        `pooled suites [${plan.suites.join(', ')}]`,
        'bash',
        ['scripts/run-all-suites.sh', ...plan.suites],
        45 * 60_000,
        distEnsured ? { MERCURY_GATE_PREBUILT: '1' } : undefined,
      ),
    )
  }
}

const ok = steps.every(s => s.ok)

console.log('\n════════ verify:fast coverage ════════')
for (const s of steps) console.log(`  ${s.ok ? '✓' : '✕'} ${s.label} (${s.seconds}s)`)
const notCovered = ['the full gate (every other domain suite)']
if (!runtimeChanged) notCovered.unshift('artifact build (no src/ changes)')
console.log(`  NOT covered: ${notCovered.join(' · ')} — release-level proof is \`bun run verify\``)

const floors = steps.filter(s => !s.label.startsWith('pooled suites')).map(s => s.label.split(' (')[0])
await recordRow(
  ok,
  'fast',
  `verify:fast slice — ${plan.suites.length > 0 ? `suites [${plan.suites.join(', ')}]` : 'no suites selected'}` +
    `${floors.length > 0 ? ` · floors [${floors.join(', ')}]` : ''}`,
)

console.log(ok ? '\n✅ verify:fast GREEN' : '\n❌ verify:fast RED')
process.exit(ok ? 0 : 1)
