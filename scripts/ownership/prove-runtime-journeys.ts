#!/usr/bin/env bun
// ============================================================================
//  scripts/ownership/prove-runtime-journeys.ts — the GOLDEN RUNTIME JOURNEYS
//  contract suite.
//
//  Each journey runs the REAL dist/mercury.mjs headless in a hermetic arena
//  (fresh HOME + MERCURY_CONFIG_DIR, pinned daemon/teams dirs, minimal PATH)
//  against the deterministic local fixture API (scripts/lib/fixtureApi.ts —
//  the SDK's ANTHROPIC_BASE_URL default routes the shipped artifact there
//  with zero source seams). What gets pinned is the OBSERVABLE cross-domain
//  contract the eight cutovers must preserve:
//
//    J1  headless text run — exact stdout, exit 0, wire shape (stream=true,
//        model echo, system prompt present, tools advertised).
//    J2  headless stream-JSON run — every stdout line individually
//        JSON-parseable (byte-contract), envelope kind sequence.
//    J3  read-tool round — tool_use(Read) executed under --allowedTools,
//        request 2 carries the tool_result with real file content, final
//        text lands on stdout.
//    J4  mutating-tool round — tool_use(Write) under implement mode actually
//        writes the file; the decision chain, execution, and result wire
//        shape all pinned.
//    J5  cancellation during model streaming — SIGINT while the fixture
//        HOLDS the stream: the client tears down the connection, no second
//        request is issued, the process exits promptly.
//    J6  resumed session — turn 1 persisted, `--resume` turn 2's request
//        carries the full prior transcript.
//
//  Goldens: scripts/ownership/goldens/runtime-journeys.json (re-record
//  deliberately with --record after a reviewed contract change).
//
//  Requires the prebuilt dist (the pooled gate prebuilds it in Phase 0).
//  Run:  ~/.bun/bin/bun run scripts/ownership/prove-runtime-journeys.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { makeNormalizer } from '../lib/goldenReplay.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const GOLDEN = join(import.meta.dir, 'goldens', 'runtime-journeys.json')
const record = process.argv.includes('--record')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — journeys exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

//
interface RunResult {
  exit: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

interface Arena {
  home: string
  cwd: string
  env: Record<string, string>
}

function makeArena(fixture: FixtureApi): Arena {
  const home = mkdtempSync(join(tmpdir(), 'ownership-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'ownership-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
    },
  }
}

function run(
  arena: Arena,
  args: string[],
  opts: { timeoutMs?: number; onSpawn?: (child: ReturnType<typeof spawn>) => void } = {},
): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
    opts.onSpawn?.(child)
    child.on('close', (exit, signal) => {
      clearTimeout(killer)
      resolvePromise({ exit, signal, stdout, stderr })
    })
  })
}

const norm = makeNormalizer()
const journeys: Record<string, unknown> = {}

//
section('J1 — headless text run (exact stdout · wire shape)')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'J1-FIXTURE-REPLY' }])
  const arena = makeArena(fixture)
  const r = await run(arena, ['-p', 'journey one', '--model', 'claude-opus-4-8'])
  const msgs = fixture.messageRequests()
  const body = (msgs[0]?.body ?? {}) as Record<string, unknown>
  check('exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`)
  check('stdout is exactly the scripted text', r.stdout === 'J1-FIXTURE-REPLY\n', JSON.stringify(r.stdout.slice(0, 120)))
  check('exactly one message request', msgs.length === 1, String(msgs.length))
  journeys['J1'] = {
    exit: r.exit,
    stdout: r.stdout,
    wire: {
      stream: body.stream === true,
      modelEchoed: body.model === 'claude-opus-4-8',
      hasSystem: Array.isArray(body.system) ? body.system.length > 0 : typeof body.system === 'string',
      advertisesTools: Array.isArray(body.tools) && (body.tools as unknown[]).length > 0,
      userMessageCount: Array.isArray(body.messages) ? (body.messages as unknown[]).length : -1,
      messagesEndpoint: msgs[0]?.path.includes('/v1/messages') ?? false,
    },
  }
  await fixture.close()
}

//
section('J2 — headless stream-JSON run (byte-parseable protocol · envelope kinds)')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'J2-STREAM-REPLY' }])
  const arena = makeArena(fixture)
  const r = await run(arena, [
    '-p',
    'journey two',
    '--model',
    'claude-opus-4-8',
    '--output-format',
    'stream-json',
    '--verbose',
  ])
  check('exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`)
  const lines = r.stdout.split('\n').filter(l => l.trim().length > 0)
  let allParse = true
  const kinds: string[] = []
  const resultMeta: Record<string, unknown> = {}
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const kind = String(parsed.type ?? '?')
      kinds.push(parsed.subtype ? `${kind}:${String(parsed.subtype)}` : kind)
      if (kind === 'result') {
        resultMeta.is_error = parsed.is_error
        resultMeta.hasResultText = typeof parsed.result === 'string' && (parsed.result as string).length > 0
        resultMeta.hasUsage = parsed.usage !== undefined
        resultMeta.hasSessionId = typeof parsed.session_id === 'string'
      }
    } catch {
      allParse = false
      kinds.push(`«unparseable:${line.slice(0, 40)}»`)
    }
  }
  check('every stdout line is individually JSON-parseable', allParse)
  check('a terminal result envelope exists', kinds.some(k => k.startsWith('result')))
  journeys['J2'] = { exit: r.exit, kinds, resultMeta }
  await fixture.close()
}

//
section('J3 — read-tool round (tool_use → local execution → tool_result → final text)')
{
  // The queue keeps element REFERENCES — turn 1's input is filled in once the
  // arena cwd exists (same pattern as J4).
  const fixtureTurns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Read', input: {} },
    { kind: 'text', text: 'J3-TOOL-DONE' },
  ]
  const fixture2 = await startFixtureApi(fixtureTurns)
  const arena = makeArena(fixture2)
  const notePath = join(arena.cwd, 'note.txt')
  writeFileSync(notePath, 'hello-from-the-fixture-file\n')
  ;(fixtureTurns[0] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = {
    file_path: notePath,
  }
  const r = await run(arena, [
    '-p',
    'read the note',
    '--model',
    'claude-opus-4-8',
    '--allowedTools',
    'Read',
  ])
  const msgs = fixture2.messageRequests()
  check('exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`)
  check('final stdout is the post-tool text', r.stdout === 'J3-TOOL-DONE\n', JSON.stringify(r.stdout.slice(0, 120)))
  check('exactly two message requests (tool round-trip)', msgs.length === 2, String(msgs.length))
  const req2 = JSON.stringify(msgs[1]?.body ?? {})
  check('request 2 carries a tool_result', req2.includes('tool_result'))
  check('request 2 tool_result carries the REAL file content', req2.includes('hello-from-the-fixture-file'))
  journeys['J3'] = {
    exit: r.exit,
    stdout: r.stdout,
    requestCount: msgs.length,
    toolResultCarried: req2.includes('tool_result') && req2.includes('hello-from-the-fixture-file'),
  }
  await fixture2.close()
}

//
section('J4 — mutating-tool round + the evidence-based stop evaluator (default path)')
{
  // Characterized (Phase 0); RE-ANCHORED:
  // with MERCURY_VERIFY_EVIDENCE default-ON, a landed mutation with NO
  // verification evidence re-prompts via the default run Stop hook — but the
  // evidence demand is now BOUNDED (MAX_EVIDENCE_DEMANDS = 2): two
  // produced-nothing demands settle the stop honestly with the UNSETTLED
  // receipt note instead of burning the whole continuation budget (the
  // unsatisfiable-loop guard). Headless -p therefore issues exactly
  // 4 model turns: tool_use · post-tool text · 2 bounded demand
  // continuations. The 5th scripted turn is the REGRESSION TRAP — if the
  // runtime ever asks a 5th time, the fixture serves it and the checks
  // below go red.
  const fixtureTurns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Write', input: {} },
    { kind: 'text', text: 'J4-MUTATION-DONE' },
    { kind: 'text', text: 'J4-CONT-1' },
    { kind: 'text', text: 'J4-CONT-2' },
    { kind: 'text', text: 'J4-CONT-3' },
  ]
  const fixture = await startFixtureApi(fixtureTurns)
  const arena = makeArena(fixture)
  const outPath = join(arena.cwd, 'j4-out.txt')
  ;(fixtureTurns[0] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = {
    file_path: outPath,
    content: 'WRITTEN-BY-THE-JOURNEY\n',
  }
  const r = await run(arena, [
    '-p',
    'write the file',
    '--model',
    'claude-opus-4-8',
    '--permission-mode',
    'implement',
  ])
  const msgs = fixture.messageRequests()
  check('exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`)
  // re-anchor: a plain -p Write now
  // COMPLETES ONE-SHOT on settled effects — the Write mints an
  // artifactDigest receipt that DISCHARGES the read-back debt, and the
  // print InvocationContract is one-shot on a settled mutation. Exactly 2
  // model turns (tool round + post-tool text), ZERO evidence re-prompts;
  // the 3-continuation fixture tail is the REGRESSION TRAP (a 3rd request
  // = the old demand loop resurfacing).
  check('final stdout is the post-tool text (one-shot completion on the settled, receipted mutation)', r.stdout === 'J4-MUTATION-DONE\n', JSON.stringify(r.stdout.slice(0, 120)))
  const written = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : '«absent»'
  check('the mutation REALLY happened (file on disk, exact bytes)', written === 'WRITTEN-BY-THE-JOURNEY\n', written.slice(0, 80))
  const req2 = JSON.stringify(msgs[1]?.body ?? {})
  check('request 2 carries a non-error tool_result', req2.includes('tool_result') && !req2.includes('"is_error":true'), req2.slice(Math.max(0, req2.indexOf('tool_result')), req2.indexOf('tool_result') + 400))
  check('exactly 2 model turns (the digest receipt discharges the read-back demand; one-shot print contract)', msgs.length === 2, String(msgs.length))
  const reprompts = msgs.slice(2).map(m => JSON.stringify(m.body).includes('Run-state check'))
  check('ZERO run-evidence re-prompts (the demand loop is DISCHARGED, not merely bounded)', reprompts.length === 0, JSON.stringify(reprompts))
  journeys['J4'] = {
    exit: r.exit,
    stdout: r.stdout,
    fileWritten: written === 'WRITTEN-BY-THE-JOURNEY\n',
    requestCount: msgs.length,
    evidenceReprompts: reprompts,
  }
  await fixture.close()
}

//
section('J5 — cancellation during model streaming (SIGINT tears down cleanly)')
{
  const fixture = await startFixtureApi([{ kind: 'hang', deltas: ['partial-', 'stream-'] }])
  const arena = makeArena(fixture)
  const startedAt = Date.now()
  const r = await run(arena, ['-p', 'journey five', '--model', 'claude-opus-4-8'], {
    timeoutMs: 30_000,
    onSpawn: child => {
      void fixture.messageRequestStarted(1).then(() => {
        // Give the child a beat to consume the partial deltas, then interrupt.
        setTimeout(() => child.kill('SIGINT'), 400)
      })
    },
  })
  const elapsed = Date.now() - startedAt
  check('process exited promptly after SIGINT (<20s)', elapsed < 20_000, `${elapsed}ms`)
  // Teardown is asserted by its RELIABLE consequences: the process exits and
  // no follow-up model turn is ever issued. (Direct socket observation is a
  // Bun http-server blind spot — see fixtureApi.sawClientAbort's caveat.)
  check('no second request after cancellation', fixture.messageRequests().length === 1, String(fixture.messageRequests().length))
  // Characterized (Phase 0): SIGINT during -p streaming currently
  // exits code 0 with 'Execution error' on stdout — pinned AS-IS; whether a
  // cancelled headless run should exit non-zero remains an open contract
  // decision.
  journeys['J5'] = {
    exitKind: r.signal ?? `code:${r.exit}`,
    stdout: r.stdout,
    secondRequestIssued: fixture.messageRequests().length > 1,
  }
  await fixture.close()
}

//
section('J6 — resumed session (turn 1 persisted; --resume carries the transcript)')
{
  const SID = 'facef00d-0000-4000-8000-0000000016a0'
  const fixture = await startFixtureApi([
    { kind: 'text', text: 'J6-FIRST-REPLY' },
    { kind: 'text', text: 'J6-SECOND-REPLY' },
  ])
  const arena = makeArena(fixture)
  const r1 = await run(arena, ['-p', 'first prompt', '--model', 'claude-opus-4-8', '--session-id', SID])
  check('turn 1 exit 0', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(0, 200)}`)
  check('turn 1 stdout', r1.stdout === 'J6-FIRST-REPLY\n', JSON.stringify(r1.stdout.slice(0, 120)))
  const r2 = await run(arena, ['-p', 'second prompt', '--model', 'claude-opus-4-8', '--resume', SID])
  check('turn 2 (resume) exit 0', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 200)}`)
  check('turn 2 stdout', r2.stdout === 'J6-SECOND-REPLY\n', JSON.stringify(r2.stdout.slice(0, 120)))
  const msgs = fixture.messageRequests()
  const req2 = JSON.stringify(msgs[1]?.body ?? {})
  check('resume request carries turn 1 user prompt', req2.includes('first prompt'))
  check('resume request carries turn 1 assistant reply', req2.includes('J6-FIRST-REPLY'))
  const req2Messages = ((msgs[1]?.body ?? {}) as { messages?: unknown[] }).messages
  check('resume request has ≥3 transcript messages', Array.isArray(req2Messages) && req2Messages.length >= 3, String(req2Messages?.length))
  journeys['J6'] = {
    turn1: { exit: r1.exit, stdout: r1.stdout },
    turn2: { exit: r2.exit, stdout: r2.stdout },
    resumeCarriedTranscript: req2.includes('first prompt') && req2.includes('J6-FIRST-REPLY'),
    resumeMessageCount: Array.isArray(req2Messages) ? req2Messages.length : -1,
  }
  await fixture.close()
}

//
section('golden pinning')
{
  const normalized = norm(journeys)
  if (record) {
    mkdirSync(dirname(GOLDEN), { recursive: true })
    writeFileSync(GOLDEN, JSON.stringify(normalized, null, 1) + '\n')
    console.log(`  [RECORDED] ${Object.keys(journeys).length} journey golden(s) → ${GOLDEN}`)
  } else if (!existsSync(GOLDEN)) {
    check('goldens exist (run --record first)', false)
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'))
    const a = JSON.stringify(golden)
    const b = JSON.stringify(normalized)
    if (a === b) {
      console.log('  [PASS] journey goldens hold byte-for-byte (normalized)')
    } else {
      let i = 0
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
      check('journey goldens hold', false, `first divergence @${i}:\n      golden:  …${a.slice(Math.max(0, i - 70), i + 90)}…\n      current: …${b.slice(Math.max(0, i - 70), i + 90)}…`)
    }
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(record ? ' ✅ JOURNEY GOLDENS RECORDED' : ' ✅ RUNTIME JOURNEYS GREEN')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} RUNTIME-JOURNEY FAILURE(S)`)
  process.exit(1)
}
