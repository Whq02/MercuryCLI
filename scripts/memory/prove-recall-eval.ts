#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-recall-eval.ts
//  THE RECALL EVAL (lane CP-B, brief §7): seeded store + real task → the
//  right cards surface AND get applied — measured, per task, end to end
//  through the REAL seams:
//
//      scanMemoryFiles → formatMemoryManifest → findRelevantMemories
//      (the routed selector wire) → readMemoriesForSurfacing (bounded read
//      + referent note) → oneShotCompletion (the eval substrate's own
//      completion seam) with the surfaced cards as context → the answer
//      grounded in the card's content.
//
//  Two modes, one corpus:
//    · suite mode (default): the selector and the apply completion run
//      against a scripted loopback whose selection rule is deterministic
//      keyword overlap and whose apply answer can only be built from text
//      the surfaced card carried onto the wire. This measures the
//      MECHANISM — scan, budget, wire, decode, read, apply — and the score
//      bar is perfection, because every leg is deterministic.
//    · --live: no fixture pinning — the real session credentials and real
//      model judge the same corpus; the matrix prints for the operator's
//      eyes and the exit stays 0 unless the PLUMBING fails (a thrown
//      transport, an API-error settle). Judgment misses are MEASURED —
//      printed and totalled, never the exit code — because a live model's
//      selection quality is the datum this mode exists to observe, and
//      gating it would turn the measuring stick red on any model quirk.
//      Suite mode gates everything. Never runs in the suite (argv-gated).
//
//  The corpus: 12 memories (4 types + experience-card shapes), 4 tasks —
//  each with a known relevant set, one with NOTHING relevant (the choosy
//  law: empty is a correct answer).
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-recall-eval.ts [--live]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.argv.includes('--live')

let failures = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (180s) — treat as failure')
  process.exit(1)
}, 180_000)
watchdog.unref?.()
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
// Judgment-class measurement: gated in suite mode, counted-not-gated live.
let judgmentMisses = 0
function measure(label: string, cond: boolean, detail = ''): void {
  if (LIVE) {
    if (!cond) judgmentMisses++
    console.log(`  [${cond ? 'HIT ' : 'MISS'}] ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    check(label, cond, detail)
  }
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-recall-eval-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.ANTHROPIC_MODEL

// ── the corpus ─────────────────────────────────────────────────────────────
const memoryDir = join(scratch, 'memdir')
mkdirSync(memoryDir, { recursive: true })
type Seed = { name: string; description: string; type: string; body: string }
const CORPUS: Seed[] = [
  { name: 'undici-dispatcher-pairing', description: 'undici dispatcher pairing causes fetch failed on node runtimes', type: 'reference', body: 'APPLY-TOKEN-UNDICI: pair the bundled dispatcher with getApiFetch(), never global fetch.' },
  { name: 'proxy-agent-classes', description: 'proxy agents and undici dispatcher interop gotchas', type: 'reference', body: 'Proxy classes conflict with the undici dispatcher on node18.' },
  { name: 'release-train-fridays', description: 'the release train departs fridays with signed tags', type: 'project', body: 'APPLY-TOKEN-RELEASE: tags are signed by the ops key before the friday train.' },
  { name: 'hotfix-skip-rule', description: 'release hotfixes may skip the train with sign-off', type: 'project', body: 'A hotfix skips the train only with an ops sign-off.' },
  { name: 'prefers-terse-summaries', description: 'the user prefers terse summaries', type: 'user', body: 'Keep summaries to three sentences.' },
  { name: 'no-db-mocks', description: 'never mock the database in integration tests', type: 'feedback', body: 'APPLY-TOKEN-DBMOCK: integration tests run the real database; a prod incident came from mocking it.' },
  { name: 'queue-over-polling', description: 'queue-over-polling judged right, keep reaching for it', type: 'feedback', body: 'Use queues, not polls, for cross-process signals.' },
  { name: 'grafana-latency-board', description: 'latency dashboards live on the api-latency grafana board', type: 'reference', body: 'Latency numbers live on the api-latency board.' },
  { name: 'tracker-quality-project', description: 'flaky-test triage lives in the QUALITY tracker project', type: 'reference', body: 'Flaky-test triage: tracker project QUALITY.' },
  { name: 'infra-background', description: 'the user is an infra engineer, frontend unfamiliar', type: 'user', body: 'Explain frontend state management from first principles.' },
  { name: 'parser-rewrite-compliance', description: 'the parser rewrite is compliance-driven for the EU launch', type: 'project', body: 'Legal needs the parser rewrite before the EU launch.' },
  { name: 'vendored-dir-hands-off', description: 'never touch the vendored ripgrep directory', type: 'feedback', body: 'The vendored dir is fetched by bun install; edits get clobbered.' },
]
for (const seed of CORPUS) {
  writeFileSync(
    join(memoryDir, `${seed.name}.md`),
    `---\nname: ${seed.name}\ndescription: ${seed.description}\ntype: ${seed.type}\n---\n\n${seed.body}\n`,
  )
}
writeFileSync(join(memoryDir, 'MEMORY.md'), CORPUS.map(s => `- [${s.name}](${s.name}.md) — ${s.description}`).join('\n') + '\n')

// ── the tasks (expected sets name FILES; empty = nothing should surface) ───
type Task = { id: string; prompt: string; expect: string[]; applyToken: string | null; keys: string[] }
const TASKS: Task[] = [
  {
    id: 'T1-wire',
    prompt: 'debugging: fetch failed under the bundled undici dispatcher when running on node — what do we know?',
    expect: ['undici-dispatcher-pairing.md', 'proxy-agent-classes.md'],
    applyToken: 'APPLY-TOKEN-UNDICI',
    keys: ['undici', 'dispatcher', 'fetch', 'node'],
  },
  {
    id: 'T2-release',
    prompt: 'planning the release: when does the train leave and what signs the tags?',
    expect: ['release-train-fridays.md', 'hotfix-skip-rule.md'],
    applyToken: 'APPLY-TOKEN-RELEASE',
    keys: ['release', 'train', 'tags', 'signed', 'hotfix'],
  },
  {
    id: 'T3-tests',
    prompt: 'writing integration tests for the billing service database layer — any standing guidance?',
    expect: ['no-db-mocks.md'],
    applyToken: 'APPLY-TOKEN-DBMOCK',
    keys: ['integration', 'tests', 'database', 'mock'],
  },
  {
    id: 'T4-none',
    prompt: 'rename the button label on the settings screen from Save to Apply',
    expect: [],
    applyToken: null,
    keys: [],
  },
]

// ── the scripted two-dialect fixture (suite mode only) ─────────────────────
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (text: string): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')

const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}

/** The deterministic selector: manifest rows scored by query-key overlap on
 *  the DESCRIPTION text; ≥2 key hits selects (mirrors "clearly useful"). */
let currentTask: Task = TASKS[0]!
function fixtureSelect(text: string): string[] {
  const picked: string[] = []
  for (const line of text.split('\n')) {
    const row = /^- (?:\[[a-z]+\] )?(\S+\.md) \(/.exec(line)
    if (!row?.[1]) continue
    const hits = currentTask.keys.filter(k => line.toLowerCase().includes(k)).length
    if (hits >= 2) picked.push(row[1])
  }
  return picked
}

/** The apply oracle: answer ONLY with the APPLY token found in the prompt's
 *  surfaced-cards section — absent token, an honest "no memory carries it". */
function fixtureApply(text: string): string {
  const token = /APPLY-TOKEN-[A-Z]+/.exec(text)?.[0]
  return token ? `Per the surfaced memory, the standing rule is ${token}.` : 'No surfaced memory carries the answer.'
}

if (!LIVE) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      const flat = collectStrings(body).join('\n')
      const isApply = flat.includes('EVAL-APPLY-CALL')
      const answer = isApply
        ? fixtureApply(flat)
        : JSON.stringify({ selected_memories: fixtureSelect(flat) })
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropicSse(answer))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: 'fixture-token',
    MERCURY_LOCAL_BASE_URL: base,
    MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
    MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
    MERCURY_COMPAT_BASE_URL: `${base}/v1`,
    MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
    MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
    MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
    MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  })
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { findRelevantMemories } = await import('../../src/memdir/findRelevantMemories.js')
const { readMemoriesForSurfacing } = await import('../../src/utils/attachments/memorySurfacing.js')
const { oneShotCompletion } = await import('../../src/services/eval/evalBridge.js')
const { sessionLightModel } = await import('../../src/utils/model/providerFrontier.js')

console.log('============================================================')
console.log(` the recall eval — ${LIVE ? 'LIVE model judgment' : 'deterministic mechanism'} over the seeded corpus`)
console.log('============================================================')

interface Row {
  task: string
  expected: number
  surfaced: number
  correct: number
  spurious: number
  applied: boolean | null
}
const matrix: Row[] = []

for (const task of TASKS) {
  currentTask = task
  section(`${task.id}: ${task.prompt.slice(0, 60)}…`)
  const selected = await findRelevantMemories(task.prompt, memoryDir, new AbortController().signal)
  const got = selected.map(s => s.path.split('/').pop()!)
  const correct = got.filter(g => task.expect.includes(g))
  const spurious = got.filter(g => !task.expect.includes(g))

  if (task.expect.length === 0) {
    measure(`${task.id}: nothing surfaces for an unrelated task (the choosy law)`, got.length === 0, JSON.stringify(got))
  } else {
    measure(
      `${task.id}: the right cards surface (${correct.length}/${task.expect.length})`,
      correct.length === task.expect.length,
      `got ${JSON.stringify(got)} want ${JSON.stringify(task.expect)}`,
    )
    measure(`${task.id}: no spurious card rides along`, spurious.length === 0, JSON.stringify(spurious))
  }

  // APPLY: the surfaced cards (post bounded-read, the exact text an agent
  // would see) ride the eval substrate's completion seam; the answer must be
  // grounded in card content that ONLY the store carried.
  let applied: boolean | null = null
  if (task.applyToken !== null) {
    const surfaced = await readMemoriesForSurfacing(selected)
    const cardsBlock = surfaced.map(s => `<memory path="${s.path}">\n${s.content}\n</memory>`).join('\n')
    let answer: string
    try {
      answer = await oneShotCompletion({
        model: sessionLightModel(),
        system: 'EVAL-APPLY-CALL: answer the task strictly from the surfaced memories; name the standing rule.',
        prompt: `${task.prompt}\n\n${cardsBlock}`,
        signal: new AbortController().signal,
      })
    } catch (error) {
      check(`${task.id}: the apply completion transport (plumbing)`, false, String(error))
      matrix.push({ task: task.id, expected: task.expect.length, surfaced: got.length, correct: correct.length, spurious: spurious.length, applied: false })
      continue
    }
    applied = answer.includes(task.applyToken)
    measure(`${task.id}: the surfaced card is APPLIED (answer grounded in its body)`, applied === true, answer.slice(0, 140))
  }
  matrix.push({ task: task.id, expected: task.expect.length, surfaced: got.length, correct: correct.length, spurious: spurious.length, applied })
}

section('the matrix')
for (const row of matrix) {
  console.log(
    `  ${row.task.padEnd(12)} expected=${row.expected} surfaced=${row.surfaced} correct=${row.correct} spurious=${row.spurious} applied=${row.applied === null ? '—' : row.applied}`,
  )
}
const perfect = matrix.every(r => r.correct === r.expected && r.spurious === 0 && r.applied !== false)
console.log(
  `  verdict: ${perfect ? 'perfect on the corpus' : 'gaps above'}${LIVE ? ` — live judgment: ${judgmentMisses} miss${judgmentMisses === 1 ? '' : 'es'} (measured, not gated)` : ''}`,
)

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ RECALL EVAL GREEN' : `❌ ${failures} RECALL-EVAL CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
