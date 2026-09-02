#!/usr/bin/env bun
// ============================================================================
//  scripts/model-policy/journey-model-policy-project-intel.ts — §7 (SOLO-RUN, BILLED)
//
//  The real built-binary journey through the project-intelligence path on
//  the default. NOT a gate member (billed real-model runner — run solo):
//    T1 fresh unpinned turn  → frontier policy resolves Fable 5 [1m]; the
//                              ContextCapsule attaches ONCE
//    T2 unchanged second turn→ NO duplicate capsule
//    set_model opus → T3     → the turn runs claude-opus-5*
//    set_model default → T4  → the frontier default again; history + capsule
//                              state survive the switches
//    resume (no model)       → the conversation's recorded model retained (§8)
//    opus micro-session      → resume retains opus (§8 restored-transcript row)
//
//  Usage: ~/.bun/bin/bun run scripts/model-policy/journey-model-policy-project-intel.ts <fixture-cwd>
//  Emits a receipts JSON beside the fixture + a compact table on stdout.
// ============================================================================
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const fixture = resolve(process.argv[2] ?? '')
if (!fixture || !existsSync(fixture)) {
  console.error('usage: journey-model-policy-project-intel.ts <fixture-cwd>')
  process.exit(2)
}
const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
const sid = crypto.randomUUID()
const sid2 = crypto.randomUUID()

// Bench-kit env scrub: the child boots pure product defaults on the REAL
// account (HOME kept — the journey needs the operator's live Max-20x facts).
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^CLAUDE/i.test(key)) continue
    if (/^ANTHROPIC/i.test(key)) continue
    if (/^HERMES_/i.test(key)) continue
    if (/^MERCURY_/i.test(key)) continue
    if (/^TF_/.test(key)) continue
    env[key] = value
  }
  return env
}

type TurnObs = {
  label: string
  initModel?: string
  assistantModels: string[]
  resultSubtype?: string
  firstInitMs?: number
  firstAssistantMs?: number
  wallMs: number
}

const ALLOW = ['Bash(ls:*)', 'Bash(cat:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(git status:*)', 'Bash(git log:*)']

// Print-mode JSONLs do NOT persist attachment rows — the dump
// (MERCURY_PULSE_DUMP) is the honest per-producer evidence surface: one record
// per attachment producer per collection, with outcome + count.
const pulseDump = join(fixture, '..', `crown-pulse-${sid.slice(0, 8)}.jsonl`)

/** One long-lived stream-json process carrying T1–T4 with set_model controls. */
function runStreamSession(): Promise<{ turns: TurnObs[]; exit: number | null }> {
  return new Promise(resolveP => {
    const t0 = performance.now()
    const argv = [
      DIST, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--session-id', sid, '-n', 'crown-journey',
      '--max-budget-usd', '6',
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
      '--allowedTools', ...ALLOW,
    ]
    const child = spawn('node', argv, {
      cwd: fixture,
      env: { ...childEnv(), MERCURY_PULSE_DUMP: pulseDump },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const turns: TurnObs[] = []
    let cur: TurnObs | null = null
    let stderrTail = ''
    const guard = setTimeout(() => child.kill('SIGKILL'), 900_000)

    const sendUser = (label: string, text: string): void => {
      cur = { label, assistantModels: [], wallMs: 0 }
      turns.push(cur)
      child.stdin!.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
      )
    }
    const sendModel = (model: string): void => {
      child.stdin!.write(
        JSON.stringify({ type: 'control_request', request_id: `set-${model}-${Date.now()}`, request: { subtype: 'set_model', model } }) + '\n',
      )
    }

    const script: Array<() => void> = [
      () => sendUser('T1-fresh-default', "What does this project's geometry module export, and where would a normalizeAngle helper belong? Answer from the project files, briefly."),
      () => sendUser('T2-post-reads', 'One line: which file owns geometry?'),
      () => { sendModel('opus'); sendUser('T3-explicit-opus', 'One line, from what you already read — no new tool calls: name the exported functions in src/format.ts.') },
      () => { sendModel('default'); sendUser('T4-back-to-default', 'One line, no tool calls: name the geometry file again, and confirm the earlier questions are still in this conversation.') },
      // T5 repeats T4 VERBATIM with zero new reads — the working set is
      // UNCHANGED, so the §7.4 dedup law says NO capsule attaches this turn.
      () => sendUser('T5-unchanged-dedup', 'One line, no tool calls: name the geometry file again, and confirm the earlier questions are still in this conversation.'),
    ]
    let step = 0
    const advance = (): void => {
      if (step < script.length) script[step++]!()
      else { child.stdin!.end() }
    }

    const rl = createInterface({ input: child.stdout! })
    rl.on('line', line => {
      const now = Math.round(performance.now() - t0)
      let e: Record<string, unknown>
      try { e = JSON.parse(line) } catch { return }
      if (e.type === 'system' && (e as { subtype?: string }).subtype === 'init' && cur) {
        cur.initModel = String((e as { model?: unknown }).model ?? '')
        cur.firstInitMs ??= now
      }
      if (e.type === 'assistant' && cur) {
        const m = (e as { message?: { model?: string } }).message?.model
        if (m && !cur.assistantModels.includes(m)) cur.assistantModels.push(m)
        cur.firstAssistantMs ??= now
      }
      if (e.type === 'result' && cur) {
        cur.resultSubtype = String((e as { subtype?: unknown }).subtype ?? '')
        cur.wallMs = now
        advance()
      }
    })
    child.stderr!.on('data', d => { stderrTail = (stderrTail + String(d)).slice(-2000) })
    child.on('close', code => {
      clearTimeout(guard)
      if (stderrTail.trim()) console.error('[stream stderr tail]', stderrTail.trim().slice(-600))
      resolveP({ turns, exit: code })
    })
    advance()
  })
}

/** One -p turn (fresh or resumed), returning observed models. */
function runOnce(argvExtra: string[], prompt: string): { models: string[]; subtype: string } {
  const out = execFileSync(
    'node',
    [DIST, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '2', '--disallowedTools', 'Edit', 'Write', ...argvExtra],
    { cwd: fixture, env: childEnv(), encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  )
  const models: string[] = []
  let subtype = ''
  for (const line of out.split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.type === 'assistant' && e.message?.model && !models.includes(e.message.model)) models.push(e.message.model)
      if (e.type === 'result') subtype = String(e.subtype ?? '')
    } catch { /* not json */ }
  }
  return { models, subtype }
}

function sessionJsonlPath(id: string): string {
  // Mercury's OWN config home ($MERCURY_HOME ?? ~/.mercury) — the built binary
  // never writes ~/.claude session stores.
  const slug = fixture.replace(/[/.]/g, '-')
  const home = process.env.MERCURY_HOME ?? join(homedir(), '.mercury')
  return join(home, 'projects', slug, `${id}.jsonl`)
}

const fails: string[] = []
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) fails.push(label)
}

console.log('=== frontier-policy §7 journey — stream session (T1–T5) ===')
const { turns, exit } = await runStreamSession()
for (const t of turns) {
  console.log(`  ${t.label}: init=${t.initModel ?? '—'} · assistant=[${t.assistantModels.join(', ')}] · ${t.resultSubtype} · first-assistant ${t.firstAssistantMs ?? '?'}ms · turn ${t.wallMs}ms`)
}
check('stream session exited cleanly', exit === 0, `exit=${exit}`)
check('5 turns observed', turns.length === 5)
const [t1, t2, t3, t4, t5] = turns
check('T1 fresh default resolves the frontier policy (Fable 5 [1m] init)', !!t1?.initModel?.includes('claude-fable-5'), t1?.initModel)
check('T1 served by claude-fable-5 (API truth)', t1?.assistantModels.every(m => m.includes('claude-fable-5')) === true, t1?.assistantModels.join(','))
check('T2 still fable, same session', t2?.assistantModels.every(m => m.includes('claude-fable-5')) === true, t2?.assistantModels.join(','))
check('T3 explicit opus wins for the turn', t3?.assistantModels.every(m => m.includes('claude-opus-5')) === true, t3?.assistantModels.join(','))
check('T4 default returns through the frontier decision', t4?.assistantModels.every(m => m.includes('claude-fable-5')) === true, t4?.assistantModels.join(','))
check('T5 stays on the default', t5?.assistantModels.every(m => m.includes('claude-fable-5')) === true, t5?.assistantModels.join(','))
check('every turn completed', turns.every(t => t.resultSubtype === 'success'), turns.map(t => t.resultSubtype).join(','))

// Capsule evidence from the dump: one line per TURN trace, each with
// per-producer records. The capsule LAW: attach when the task-scoped working
// set is NEW or CHANGED (T1 fresh; T2 after T1's reads changed it — lawful,
// delta-annotated); NEVER re-attach an unchanged set (T5 repeats T4 verbatim
// with zero new reads ⇒ its turn-start collection is EMPTY); model switches
// never force a re-attach by themselves.
const dumpLines = readFileSync(pulseDump, 'utf8').trim().split('\n')
const perTurnAttached: number[] = []
for (const line of dumpLines) {
  try {
    const e = JSON.parse(line) as { producers?: Array<{ label?: string; count?: number }> }
    if (!e.producers) continue
    perTurnAttached.push(
      (e.producers ?? []).filter(p => p.label === 'context_capsule' && (p.count ?? 0) > 0).length,
    )
  } catch { /* not json */ }
}
check(
  'capsule law: T1 attaches (≥1 — a mid-turn read change lawfully re-attaches with a delta) · some later turn dedups to 0 · T5 verbatim-unchanged attaches NOTHING',
  perTurnAttached.length === 5 &&
    (perTurnAttached[0] ?? 0) >= 1 &&
    perTurnAttached[4] === 0 &&
    perTurnAttached.slice(1, 4).some(n => n === 0),
  `per-turn=[${perTurnAttached.join(',')}] (dump ${pulseDump})`,
)
const jsonl = readFileSync(sessionJsonlPath(sid), 'utf8')
const userCount = (jsonl.match(/"role":"user"/g) ?? []).length
check('history intact (≥5 user turns in one conversation)', userCount >= 5, `users=${userCount}`)

console.log('\n=== §8 resume retention ===')
const resumed = runOnce(['--resume', sid], 'One line: still here?')
check('resume (no --model) retains the conversation model (fable)', resumed.models.every(m => m.includes('claude-fable-5')) && resumed.models.length > 0, resumed.models.join(','))
const opusT1 = runOnce(['--session-id', sid2, '--model', 'opus'], 'One line: say ok.')
check('opus micro-session ran on opus', opusT1.models.every(m => m.includes('claude-opus-5')) && opusT1.models.length > 0, opusT1.models.join(','))
const opusResumed = runOnce(['--resume', sid2], 'One line: say ok again.')
check('resume retains the OPUS transcript model (§8)', opusResumed.models.every(m => m.includes('claude-opus-5')) && opusResumed.models.length > 0, opusResumed.models.join(','))

const receipts = { sid, sid2, turns, perTurnAttached, resumed, opusT1, opusResumed }
const out = join(fixture, '..', 'crown-journey-receipts.json')
writeFileSync(out, JSON.stringify(receipts, null, 2))
console.log(`\nreceipts → ${out}`)
if (fails.length) { console.log(`❌ ${fails.length} journey check(s) failed`); process.exit(1) }
console.log('✅ frontier-policy §7 journey: all checks pass')
