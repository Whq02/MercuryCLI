#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-experience/benchmark.ts — the cold-start agent-experience
//  benchmark: twelve first-session tasks, headless (-p) on the built bundle,
//  in a scratch project with a scratch config home, scored per run.
//
//    MECHANICAL legs  — one per provider family (Anthropic Messages · OpenAI
//                       Responses · chat-completions on Z.AI · the same wire
//                       on the OpenRouter carrier), a scripted model on the
//                       loopback fixture: zero spend, deterministic; measures
//                       the harness side — prompt/tool bytes, result sizes,
//                       error texts, the per-dialect tool loop.
//    LIVE leg         — the operator's saved default (a FREE OpenRouter model,
//                       confirmed from the config; zero spend): the one
//                       real-model behaviour sample.
//
//  bash scripts/agent-experience/benchmark.sh [--families anthropic,openai,chat,openrouter | all]
//      [--live] [--tasks id,id] [--out DIR] [--record LABEL] [--serial] [--port N]
//      [--dist PATH] [--timeout-ms N]
// ============================================================================
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { FAMILIES, MECHANICAL_FAMILIES, startBenchmarkFixture, type BenchmarkFixture, type FamilyId, type FixtureHit } from './lib/fixture.ts'
import { createScratchProject, type ScratchProject } from './lib/project.ts'
import { renderSummary, totals, writeFamilyTable, type FamilyHeader, type FamilyTable, type TaskRow } from './lib/report.ts'
import { runHeadless, type RunRecord } from './lib/runner.ts'
import { scoreRun } from './lib/score.ts'
import { TASKS, type TaskContext, type TaskDef } from './lib/tasks.ts'
import { systemPromptText, toolRoster } from './lib/wire.ts'

export const HERE = resolve(import.meta.dir)
export const ROOT = resolve(HERE, '..', '..')
export const DEFAULT_PORT = 34200

export interface BenchmarkOptions {
  families: FamilyId[]
  live: boolean
  tasks: string[] | null
  out: string
  record: string | null
  serial: boolean
  port: number
  dist: string
  timeoutMs: number
  liveTimeoutMs: number
  /** The live model id (read from the operator's config unless given). */
  liveModel: string | null
  /** The live key (env OPENROUTER_API_KEY, else the operator's minted key). */
  liveKey: string | null
  /** Mechanical legs carry only their own family's base URL (no other
   *  family's pin at the fixture) — the literal one-provider operator shape. */
  bareFamilyEnv: boolean
  quiet: boolean
}

export interface BenchmarkResult {
  out: string
  tables: FamilyTable[]
  summaryPath: string
  fixtureHits: FixtureHit[]
}

export function parseArgs(argv: string[]): BenchmarkOptions {
  const opts: BenchmarkOptions = {
    families: [...MECHANICAL_FAMILIES],
    live: false,
    tasks: null,
    out: '',
    record: null,
    serial: false,
    port: DEFAULT_PORT,
    dist: join(ROOT, 'dist', 'mercury.mjs'),
    timeoutMs: 150_000,
    liveTimeoutMs: 360_000,
    liveModel: null,
    liveKey: null,
    bareFamilyEnv: false,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--families') {
      const v = next()
      opts.families = v === 'all' || v === 'mechanical' ? [...MECHANICAL_FAMILIES] : v === 'none' ? [] : (v.split(',').map(s => s.trim()).filter(Boolean) as FamilyId[])
      for (const f of opts.families) if (!(f in FAMILIES)) throw new Error(`unknown family ${f} (known: ${MECHANICAL_FAMILIES.join(', ')})`)
    } else if (a === '--live') opts.live = true
    else if (a === '--live-only') {
      opts.live = true
      opts.families = []
    } else if (a === '--tasks') opts.tasks = next().split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--out') opts.out = resolve(next())
    else if (a === '--record') opts.record = next()
    else if (a === '--serial') opts.serial = true
    else if (a === '--port') opts.port = Number(next())
    else if (a === '--dist') opts.dist = resolve(next())
    else if (a === '--timeout-ms') opts.timeoutMs = Number(next())
    else if (a === '--live-timeout-ms') opts.liveTimeoutMs = Number(next())
    else if (a === '--live-model') opts.liveModel = next()
    else if (a === '--bare-family-env') opts.bareFamilyEnv = true
    else if (a === '--quiet') opts.quiet = true
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(new URL(import.meta.url)).toString('utf8').split('\n').slice(1, 22).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!opts.out) opts.out = mkdtempSync(join(tmpdir(), 'mercury-ax-bench-'))
  return opts
}

/** The operator's saved default model — read from the real config home,
 *  read-only, never assumed. */
export function readSavedDefaultModel(): { model: string | null; source: string } {
  const home = process.env.MERCURY_CONFIG_DIR?.trim() || join(process.env.HOME ?? '', '.mercury')
  const settings = join(home, 'settings.json')
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as { model?: unknown }
    return { model: typeof parsed.model === 'string' ? parsed.model : null, source: settings }
  } catch {
    return { model: null, source: settings }
  }
}

/** The OpenRouter credential for the live leg: env first, else the minted key
 *  the operator's sign-in stored (read-only; the value never leaves the
 *  child's env). */
export function readOpenrouterKey(): { key: string | null; source: string } {
  const env = process.env.OPENROUTER_API_KEY?.trim()
  if (env) return { key: env, source: 'OPENROUTER_API_KEY (env)' }
  const home = process.env.MERCURY_CONFIG_DIR?.trim() || join(process.env.HOME ?? '', '.mercury')
  const file = join(home, '.openrouter-auth.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { minted?: { key?: unknown } }
    const key = typeof parsed.minted?.key === 'string' ? parsed.minted.key : null
    return { key, source: key ? `${file} (minted key)` : `${file} (no minted key)` }
  } catch {
    return { key: null, source: `${file} (absent)` }
  }
}

export function browserAvailable(): { ok: boolean; note: string } {
  const pin = process.env.MERCURY_BROWSER_PATH?.trim()
  if (pin && existsSync(pin)) return { ok: true, note: `MERCURY_BROWSER_PATH ${pin}` }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
  for (const c of candidates) if (existsSync(c)) return { ok: true, note: c }
  return { ok: false, note: 'no Chromium-family browser at the standard locations (MERCURY_BROWSER_PATH pins one)' }
}

function treeSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, stdio: 'pipe' }).toString('utf8').trim()
  } catch {
    return 'unknown'
  }
}

function nodeBinary(): string {
  const which = process.env.MERCURY_AX_NODE?.trim() || Bun.which('node')
  if (!which) throw new Error('no node binary on PATH')
  return which
}

interface FamilyRunPlan {
  id: string
  label: string
  model: string
  backend: string
  dialect: string
  mechanical: boolean
  env: Record<string, string>
  timeoutMs: number
}

function baseEnv(home: string, nodeBin: string): Record<string, string> {
  return {
    HOME: home,
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    NO_COLOR: '1',
    LANG: 'en_US.UTF-8',
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
  }
}

async function runFamily(plan: FamilyRunPlan, opts: BenchmarkOptions, fixture: BenchmarkFixture, tasks: TaskDef[], nodeBin: string, when: string, tree: string): Promise<FamilyTable> {
  const famDir = join(opts.out, plan.id)
  const home = join(famDir, 'home')
  mkdirSync(home, { recursive: true })
  const projectDirs = tasks.filter(t => !t.resumeOf).map(t => join(famDir, 'tasks', t.id, 'project'))
  seedFirstRun(join(home, '.mercury'), projectDirs)
  const env = { ...baseEnv(home, nodeBin), ...plan.env }
  const browser = browserAvailable()
  const projects = new Map<string, ScratchProject>()
  const sessions = new Map<string, string>()
  const runs = new Map<string, RunRecord>()
  const rows: TaskRow[] = []
  const notes: string[] = []
  let promptFacts: { promptChars: number; toolNames: string[]; toolSchemaChars: number } | null = null
  let initToolNames: string[] | null = null
  const log = (s: string): void => {
    if (!opts.quiet) console.log(`  [${plan.id}] ${s}`)
  }
  for (const task of tasks) {
    const project = task.resumeOf ? projects.get(task.resumeOf) : createScratchProject(join(famDir, 'tasks', task.id, 'project'))
    if (!project) {
      rows.push(placeholderRow(task, `phase 1 (${task.resumeOf}) did not run`))
      continue
    }
    projects.set(task.id, project)
    const ctx: TaskContext = { projectDir: project.dir, pageUrl: fixture.pageUrl, mechanical: plan.mechanical, facts: project.facts, nodeBin }
    if (task.needs === 'browser' && !browser.ok) {
      rows.push(placeholderRow(task, `unmeasured — ${browser.note}`))
      log(`${task.id}: skipped — ${browser.note}`)
      continue
    }
    if (fixture && plan.mechanical) {
      fixture.setScript(plan.id as FamilyId, task.id, task.script(ctx))
      const seats = task.seats?.(ctx) ?? {}
      for (const [seatId, turns] of Object.entries(seats)) fixture.setSeat(plan.id as FamilyId, seatId, turns)
    }
    const sessionId = task.resumeOf ? undefined : randomUUID()
    const resume = task.resumeOf ? sessions.get(task.resumeOf) : undefined
    const hitsBefore = fixture ? fixture.hits.length : 0
    const startedAt = Date.now()
    const run = await runHeadless({
      dist: opts.dist,
      nodeBin,
      cwd: project.dir,
      env,
      model: plan.model,
      prompt: task.prompt(ctx),
      allowedTools: task.allowedTools,
      maxTurns: task.maxTurns,
      permissionMode: 'default',
      sessionId,
      resume,
      timeoutMs: plan.timeoutMs,
    })
    runs.set(task.id, run)
    if (sessionId) sessions.set(task.id, run.sessionId || sessionId)
    const hits = fixture ? fixture.hits.slice(hitsBefore).filter(h => h.family === plan.id) : []
    if (!promptFacts) {
      const main = hits.find(h => h.kind === 'main')
      if (main && main.dialect) {
        const roster = toolRoster(main.body, main.dialect)
        // Measured with the scratch paths normalised out: the prompt quotes
        // the working directory and the memory directory, and their length
        // is this machine's, not the harness's.
        const prompt = normalisePaths(systemPromptText(main.body, main.dialect), { project: project.dir, home, out: opts.out })
        promptFacts = { promptChars: prompt.length, toolNames: roster.names, toolSchemaChars: roster.schemaChars }
        mkdirSync(join(opts.out, 'prompts'), { recursive: true })
        writeFileSync(join(opts.out, 'prompts', `${plan.id}.system.txt`), prompt)
        writeFileSync(join(opts.out, 'prompts', `${plan.id}.tools.json`), JSON.stringify(main.body.tools ?? [], null, 1))
      }
    }
    if (!initToolNames && run.init && Array.isArray((run.init as { tools?: unknown }).tools)) {
      initToolNames = ((run.init as { tools: unknown[] }).tools).map(t => (typeof t === 'string' ? t : String((t as { name?: string }).name ?? '')))
    }
    const verdict = task.oracle(ctx, { run, hits, prior: task.resumeOf ? runs.get(task.resumeOf) : undefined })
    // Probes are the SCRIPT's deliberate mistakes — a live model makes its
    // own, and every one of those counts as unexpected.
    const score = scoreRun(run, verdict, plan.mechanical ? task.probeTools.map(tool => ({ tool, probe: true })) : [])
    const row: TaskRow = {
      task: task.id,
      title: task.title,
      skipped: null,
      allowedTools: task.allowedTools,
      finalText: run.finalText.slice(0, 400),
      stderrTail: run.stderr.slice(-600),
      ...score,
    }
    rows.push(row)
    // The raw record beside the table: envelopes + this run's fixture hits
    // (bodies trimmed to what the audit needs).
    const runDir = join(famDir, 'runs')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, `${task.id}.jsonl`), run.envelopes.map(e => JSON.stringify(e)).join('\n') + '\n')
    writeFileSync(
      join(runDir, `${task.id}.hits.json`),
      JSON.stringify(hits.map(h => ({ kind: h.kind, path: h.path, model: h.model, taskId: h.taskId, seatId: h.seatId, results: h.results, at: h.at, tools: toolRoster(h.body, h.dialect ?? 'chat').names.length, bytes: h.raw.length })), null, 1),
    )
    if (run.stderr.trim()) writeFileSync(join(runDir, `${task.id}.stderr.txt`), run.stderr)
    // MERCURY_AX_DUMP_HITS=1: every request body this run sent to the
    // fixture, verbatim — the wire-level audit for the prompt and tool lanes.
    if (process.env.MERCURY_AX_DUMP_HITS === '1') {
      hits.forEach((h, i) => writeFileSync(join(runDir, `${task.id}.hit-${i + 1}.${h.kind}.json`), h.raw))
    }
    log(`${task.id}: ${score.success === true ? 'PASS' : score.success === false ? 'FAIL' : 'n/a'} · turns ${score.turns} · calls ${score.toolCalls} · wasted ${score.wasted} (probes ${score.probes}) · result-tokens ≈${score.toolResultTokensEst}${score.imageChars ? ` +img ${score.imageChars}` : ''} · asks ${score.asks} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${score.resultSubtype}${run.timedOut ? ' TIMEOUT' : ''}`)
    if (score.success !== true && !opts.quiet) log(`   oracle: ${verdict.detail}`)
  }
  if (!browser.ok) notes.push(`browser task unmeasured: ${browser.note}`)
  const toolCount = promptFacts?.toolNames.length ?? initToolNames?.length ?? null
  const header: FamilyHeader = {
    family: plan.id,
    label: plan.label,
    model: plan.model,
    backend: plan.backend,
    dialect: plan.dialect,
    mechanical: plan.mechanical,
    tree,
    fold: process.env.MERCURY_AX_FOLD_LABEL?.trim() || 'unlabelled',
    when,
    promptChars: promptFacts?.promptChars ?? null,
    promptTokensEst: promptFacts ? Math.round(promptFacts.promptChars / 4) : null,
    toolCount,
    toolNames: promptFacts?.toolNames ?? initToolNames ?? [],
    toolSchemaChars: promptFacts?.toolSchemaChars ?? null,
    notes,
  }
  return { header, rows }
}

/** Replace this run's scratch paths (and the product's config-key spelling
 *  of them, slashes to dashes) with stable placeholders. */
export function normalisePaths(text: string, paths: { project: string; home: string; out: string }): string {
  const keyOf = (p: string): string => p.replace(/[\\/]/g, '-')
  // The product may quote the resolved path (macOS: /var → /private/var);
  // both spellings of each path normalise, the longer first.
  const variants = (p: string): string[] => {
    let real = p
    try {
      real = realpathSync(p)
    } catch {
      /* not created yet — the literal spelling is all there is */
    }
    return [...new Set([real, p])].sort((a, b) => b.length - a.length)
  }
  let out = text
  for (const p of variants(paths.project)) out = out.split(p).join('<project>').split(keyOf(p)).join('<project-key>')
  for (const p of variants(paths.home)) out = out.split(join(p, '.mercury')).join('<config-home>').split(p).join('<home>')
  for (const p of variants(paths.out)) out = out.split(p).join('<out>')
  return out
}

function placeholderRow(task: TaskDef, skipped: string): TaskRow {
  return {
    task: task.id,
    title: task.title,
    skipped,
    allowedTools: task.allowedTools,
    finalText: '',
    stderrTail: '',
    success: null,
    oracle: skipped,
    turns: 0,
    toolCalls: 0,
    wasted: 0,
    probes: 0,
    unexpectedErrors: 0,
    duplicates: 0,
    toolResultChars: 0,
    toolResultTokensEst: 0,
    imageChars: 0,
    injectedTokensEst: 0,
    subagentResultTokensEst: 0,
    asks: 0,
    denials: 0,
    errors: [],
    wallMs: 0,
    exitCode: null,
    timedOut: false,
    resultSubtype: 'skipped',
    usage: null,
    costUsd: null,
  }
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  if (!existsSync(opts.dist)) throw new Error(`built bundle absent at ${opts.dist} — run \`bun run build.ts\` first`)
  const nodeBin = nodeBinary()
  mkdirSync(opts.out, { recursive: true })
  const tasks = opts.tasks ? TASKS.filter(t => opts.tasks!.includes(t.id) || (t.resumeOf && opts.tasks!.includes(t.resumeOf)) || opts.tasks!.includes(t.id)) : TASKS
  const when = new Date().toISOString()
  const tree = treeSha()
  const plans: FamilyRunPlan[] = []
  // The fixture always runs: the mechanical families ride its four provider
  // lanes; the live leg only opens its web page (no provider pins).
  const fixture = await startBenchmarkFixture({ port: opts.port })
  for (const id of opts.families) {
    const spec = FAMILIES[id]
    plans.push({ id, label: spec.label, model: spec.model, backend: spec.backend, dialect: spec.dialect, mechanical: true, env: fixture.envFor(id, opts.bareFamilyEnv ? 'bare' : 'pinned'), timeoutMs: opts.timeoutMs })
  }
  if (opts.live) {
    const saved = readSavedDefaultModel()
    const model = opts.liveModel ?? saved.model
    if (!model) throw new Error(`live leg: no saved default model in ${saved.source} and no --live-model given`)
    if (!model.startsWith('openrouter/')) throw new Error(`live leg: the saved default ${model} is not an OpenRouter id — the live leg rides the free OpenRouter default only (zero spend)`)
    const cred = opts.liveKey ? { key: opts.liveKey, source: 'given' } : readOpenrouterKey()
    if (!cred.key) throw new Error(`live leg: no OpenRouter credential (${cred.source})`)
    if (!opts.quiet) console.log(`live leg: model ${model} (from ${saved.source}); credential from ${cred.source}`)
    plans.push({ id: 'live', label: `live — ${model}`, model, backend: 'openrouter-chat', dialect: 'chat', mechanical: false, env: { OPENROUTER_API_KEY: cred.key }, timeoutMs: opts.liveTimeoutMs })
  }
  if (!opts.quiet) console.log(`agent-experience benchmark · tree ${tree} · out ${opts.out} · families ${plans.map(p => p.id).join(', ') || 'none'} · tasks ${tasks.length}`)
  const tables: FamilyTable[] = []
  try {
    if (opts.serial) {
      for (const plan of plans) tables.push(await runFamily(plan, opts, fixture, tasks, nodeBin, when, tree))
    } else {
      const settled = await Promise.all(plans.map(plan => runFamily(plan, opts, fixture, tasks, nodeBin, when, tree)))
      tables.push(...settled)
    }
  } finally {
    await fixture.close()
  }
  // Foreign traffic census: every request that hit the fixture outside the
  // four provider lanes and the page (boot-time discovery probes and the
  // like). A POST here would be a wire nobody scripted.
  const foreign = new Map<string, number>()
  for (const h of fixture.hits) if (h.kind === 'other') foreign.set(`${h.method} ${h.path}`, (foreign.get(`${h.method} ${h.path}`) ?? 0) + 1)
  if (!opts.quiet && foreign.size > 0) console.log(`foreign requests at the fixture: ${[...foreign.entries()].map(([k, n]) => `${k} ×${n}`).join(' · ')}`)
  for (const table of tables) writeFamilyTable(opts.out, table)
  const summary = renderSummary(tables, `Agent-experience benchmark — ${tree}`)
  const summaryPath = join(opts.out, 'summary.md')
  writeFileSync(summaryPath, summary)
  if (opts.record) {
    const dir = join(HERE, 'baselines', opts.record)
    mkdirSync(dir, { recursive: true })
    for (const table of tables) cpSync(join(opts.out, `${table.header.family}.json`), join(dir, `${table.header.family}.json`))
    cpSync(summaryPath, join(dir, 'summary.md'))
    // The assembled system prompt per family rides the record (the diff
    // steps 2 and 4 read); the tool-schema JSON stays in the run directory —
    // its size and roster are already in the header. Copied PER FILE:
    // bun's cpSync with a `filter` never overwrites an existing destination
    // file (proved in a minimal repro), so a filtered recursive copy left
    // every re-record's prompt captures at their first-recorded bytes —
    // a stale one-content instrument.
    const promptsSrc = join(opts.out, 'prompts')
    if (existsSync(promptsSrc)) {
      const promptsDir = join(dir, 'prompts')
      mkdirSync(promptsDir, { recursive: true })
      for (const f of readdirSync(promptsSrc)) {
        if (f.endsWith('.tools.json')) continue
        cpSync(join(promptsSrc, f), join(promptsDir, f))
      }
    }
    if (!opts.quiet) console.log(`recorded under ${dir}`)
  }
  if (!opts.quiet) {
    console.log('')
    for (const table of tables) {
      const s = totals(table.rows)
      console.log(`${table.header.family.padEnd(11)} ${s.pass}/${s.pass + s.fail} pass${s.skipped ? ` (${s.skipped} skipped)` : ''} · turns ${s.turns} · wasted ${s.wasted} (unexpected ${s.unexpected}) · result-tokens ≈${s.tokens} · asks ${s.asks} · prompt ${table.header.promptChars ?? '?'} chars · tools ${table.header.toolCount ?? '?'} · ${(s.wallMs / 1000).toFixed(0)}s`)
    }
    console.log(`\nsummary: ${summaryPath}`)
  }
  return { out: opts.out, tables, summaryPath, fixtureHits: fixture?.hits ?? [] }
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2))
  runBenchmark(opts)
    .then(result => {
      const anyHarnessFailure = result.tables.some(t => t.rows.some(r => !r.skipped && (r.timedOut || r.exitCode === null)))
      process.exit(anyHarnessFailure ? 1 : 0)
    })
    .catch(error => {
      console.error(`benchmark failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exit(2)
    })
}
