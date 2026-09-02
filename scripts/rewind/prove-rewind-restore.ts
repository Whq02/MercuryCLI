#!/usr/bin/env bun
// ============================================================================
//  scripts/rewind/prove-rewind-restore.ts — THE RESTORE, DRIVEN REAL
//  (release-hardening audit FN-015 rank 8): the built runner, a fixture
//  provider, the rewind_session control over its own stdin — the exact road
//  the daemon's seat drives — no PTY, no daemon process.
//
//  THE FINDING: "even if there were a restore point, the restore would
//  refuse". Here a real seat runner (a -p stream-json child wearing the
//  worker stamp) runs two tool turns, then:
//   §1 THE FACTS carry the checkpoints (capture on, the two turns restorable).
//   §2 CODE — a dry run names the file and the line counts, writes nothing;
//      the restore puts the turn-1 bytes back; the receipt names the file.
//   §3 NO-CHECKPOINT — a point the store never saw answers typed.
//   §4 DRIFT — a hand edit after the session's last touch refuses BY NAME
//      and restores NOTHING (the hand edit survives, the sibling file too).
//   §5 CONVERSATION — the record lands in the transcript (same session,
//      same file) and the NEXT model call carries the classic truncation:
//      the fixture's captured request body holds the first turn only.
//   §6 BOTH — one receipt naming the files and the boundary; the transcript
//      keeps every row (append-only).
//
//  Requires the prebuilt dist. Run:
//    ~/.bun/bin/bun run scripts/rewind/prove-rewind-restore.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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
  console.log('\n❌ TIMEOUT — rewind restore proofs exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

type Envelope = Record<string, unknown> & { type: string; subtype?: string }
type Receipt = {
  outcome?: string
  mode?: string
  refusal?: string
  detail?: string
  dryRun?: boolean
  code?: { filesChanged: string[]; insertions: number; deletions: number }
  conversation?: { turnUuid: string; removed: number }
}

function findTranscript(root: string, sessionId: string): string | null {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (name === `${sessionId}.jsonl`) return p
    }
  }
  return null
}

// ── the scene ───────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'rewind-restore-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'rewind-restore-cwd-'))
const configDir = join(home, '.claude')
mkdirSync(configDir, { recursive: true })
const alpha = join(cwd, 'alpha.txt')
const beta = join(cwd, 'beta.txt')
writeFileSync(alpha, 'alpha-0\n')
writeFileSync(beta, 'beta-0\n')

// Turn 1: read+write alpha (alpha-1) and beta (beta-1). Turn 2: write alpha
// again (alpha-2). Turn 3 (after the conversation rewind): a text reply —
// its REQUEST BODY is the provider-bound view under proof. Turn 4: the
// 'both' scene's tool turn (a read first — the operator hand-edited alpha
// in the drift scene). Turn 5: a final text reply.
const fixture: FixtureApi = await startFixtureApi([
  { kind: 'tool_use', name: 'Read', input: { file_path: alpha }, id: 'toolu_r_a1' },
  { kind: 'tool_use', name: 'Write', input: { file_path: alpha, content: 'alpha-1\n' }, id: 'toolu_w_a1' },
  { kind: 'tool_use', name: 'Read', input: { file_path: beta }, id: 'toolu_r_b1' },
  { kind: 'tool_use', name: 'Write', input: { file_path: beta, content: 'beta-1\n' }, id: 'toolu_w_b1' },
  { kind: 'text', text: 'TURN-ONE-DONE.' },
  { kind: 'tool_use', name: 'Write', input: { file_path: alpha, content: 'alpha-2\n' }, id: 'toolu_w_a2' },
  { kind: 'text', text: 'TURN-TWO-DONE.' },
  { kind: 'text', text: 'TURN-THREE-DONE.' },
  { kind: 'tool_use', name: 'Read', input: { file_path: alpha }, id: 'toolu_r_a4' },
  { kind: 'tool_use', name: 'Write', input: { file_path: alpha, content: 'alpha-4\n' }, id: 'toolu_w_a4' },
  { kind: 'text', text: 'TURN-FOUR-DONE.' },
  { kind: 'text', text: 'TURN-FIVE-DONE.' },
])
const sessionId = randomUUID()
const env: Record<string, string> = {
  HOME: home,
  PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: configDir,
  ANTHROPIC_BASE_URL: fixture.url,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_CONCOURSE_WORKER: '1',
}
const child = spawn(
  nodeBin,
  [DIST, '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-8', '--session-id', sessionId, '--allowedTools', 'Read', 'Write'],
  { cwd, env },
)
const killer = setTimeout(() => child.kill('SIGKILL'), 200_000)
const envelopes: Envelope[] = []
const waiters: Array<{ pred: (e: Envelope) => boolean; res: (e: Envelope) => void }> = []
let buf = ''
child.stdout.on('data', d => {
  buf += String(d)
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl === -1) break
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as Envelope
      envelopes.push(e)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(e)) {
          const w = waiters.splice(i, 1)[0]!
          w.res(e)
        }
      }
    } catch {
      /* non-JSON line */
    }
  }
})
let stderr = ''
child.stderr.on('data', d => (stderr += d))
const exited = new Promise<number | null>(res =>
  child.on('close', code => {
    clearTimeout(killer)
    res(code)
  }),
)
const waitFor = (pred: (e: Envelope) => boolean, label: string, timeoutMs = 60_000): Promise<Envelope | undefined> =>
  new Promise(res => {
    const hit = envelopes.find(pred)
    if (hit) return res(hit)
    const t = setTimeout(() => {
      console.log(`  [dbg] waitFor timeout: ${label}; envelopes=${j(envelopes.map(e => `${e.type}:${e.subtype ?? ''}`))} stderr=${stderr.slice(-400)}`)
      res(undefined)
    }, timeoutMs)
    waiters.push({
      pred,
      res: e => {
        clearTimeout(t)
        res(e)
      },
    })
  })
const send = (o: unknown): void => {
  child.stdin.write(JSON.stringify(o) + '\n')
}
let seq = 0
async function control(request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const requestId = `mercury-seat-rewind-prover-${++seq}`
  send({ type: 'control_request', request_id: requestId, request })
  const resp = await waitFor(e => e.type === 'control_response' && j(e).includes(requestId), `control ${String(request.subtype)}`)
  // The envelope: { type, response: { subtype, request_id, response: PAYLOAD } }.
  return (resp as { response?: { response?: Record<string, unknown> } } | undefined)?.response?.response
}
async function turn(text: string, uuid: string): Promise<Envelope | undefined> {
  const before = envelopes.filter(e => e.type === 'result').length
  send({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null })
  return waitFor(e => e.type === 'result' && envelopes.filter(x => x.type === 'result').length > before, `result for ${text}`)
}
const readTranscriptRows = (): string[] => {
  const path = findTranscript(configDir, sessionId)
  return path ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '') : []
}

send({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } })
await waitFor(e => e.type === 'control_response' && j(e).includes('req_init'), 'initialize')

const turn1 = randomUUID()
const turn2 = randomUUID()
const r1 = await turn('turn one: set alpha and beta', turn1)
const r2 = await turn('turn two: set alpha again', turn2)
check('the two tool turns settled', r1?.subtype === 'success' && r2?.subtype === 'success', j({ r1: r1?.subtype, r2: r2?.subtype, stderr: stderr.slice(-300) }))
check('alpha holds the turn-2 bytes and beta the turn-1 bytes before any rewind', readFileSync(alpha, 'utf8') === 'alpha-2\n' && readFileSync(beta, 'utf8') === 'beta-1\n', `${readFileSync(alpha, 'utf8')}|${readFileSync(beta, 'utf8')}`)

// ── §1 the facts ────────────────────────────────────────────────────────────
section('§1 — the facts: capture on, both turns restorable')
{
  const facts = (await control({ subtype: 'session_facts' })) as { fileCheckpoints?: { capture?: boolean; restorable?: string[] } } | undefined
  const fc = facts?.fileCheckpoints
  check('session_facts carries fileCheckpoints with capture ON', fc?.capture === true, j(fc))
  check('…and both turns are restorable (the cockpit offers a code restore there)', Array.isArray(fc?.restorable) && fc.restorable.includes(turn1) && fc.restorable.includes(turn2), j(fc?.restorable))
}

// ── §2 code ─────────────────────────────────────────────────────────────────
section('§2 — code: a dry run names the file and writes nothing; the restore puts the bytes back')
{
  const dry = (await control({ subtype: 'rewind_session', user_message_id: turn2, mode: 'code', dry_run: true })) as Receipt | undefined
  check('the dry run answers applied + dryRun naming alpha with its counts', dry?.outcome === 'applied' && dry.dryRun === true && dry.code?.filesChanged.length === 1 && dry.code.filesChanged[0]!.endsWith('alpha.txt') && dry.code.insertions === 1 && dry.code.deletions === 1, j(dry))
  check('…and wrote nothing', readFileSync(alpha, 'utf8') === 'alpha-2\n')
  const applied = (await control({ subtype: 'rewind_session', user_message_id: turn2, mode: 'code' })) as Receipt | undefined
  check('the restore to turn 2 answers applied naming alpha', applied?.outcome === 'applied' && applied.code?.filesChanged.length === 1 && applied.code.filesChanged[0]!.endsWith('alpha.txt'), j(applied))
  check('alpha is back to its turn-1 bytes (the state when turn 2 began)', readFileSync(alpha, 'utf8') === 'alpha-1\n', readFileSync(alpha, 'utf8'))
  check('beta, untouched since turn 1, is unchanged', readFileSync(beta, 'utf8') === 'beta-1\n')
  const again = (await control({ subtype: 'rewind_session', user_message_id: turn2, mode: 'code' })) as Receipt | undefined
  check('a second restore to the same point is a typed noop (the files already match)', again?.outcome === 'noop', j(again))
  const toOne = (await control({ subtype: 'rewind_session', user_message_id: turn1, mode: 'code' })) as Receipt | undefined
  check('the restore to turn 1 puts BOTH files back to their pre-session bytes', toOne?.outcome === 'applied' && readFileSync(alpha, 'utf8') === 'alpha-0\n' && readFileSync(beta, 'utf8') === 'beta-0\n', j({ toOne, alpha: readFileSync(alpha, 'utf8'), beta: readFileSync(beta, 'utf8') }))
}

// ── §3 no checkpoint ────────────────────────────────────────────────────────
section('§3 — no checkpoint: a point the store never saw answers typed')
{
  const none = (await control({ subtype: 'rewind_session', user_message_id: randomUUID(), mode: 'code' })) as Receipt | undefined
  check("an unknown point answers refused 'not-found' (typed, never an error frame)", none?.outcome === 'refused' && none.refusal === 'not-found', j(none))
}

// ── §4 drift ────────────────────────────────────────────────────────────────
section('§4 — drift: a hand edit after the session\'s last touch refuses by name, restoring nothing')
{
  // Put the tree back at turn 2's end first (alpha-2, beta-1), so a restore
  // to turn 2 would have work to do — then edit alpha BY HAND.
  writeFileSync(alpha, 'alpha-2\n')
  writeFileSync(beta, 'beta-1\n')
  // beta's clock sits BEFORE the session's last touch (not drift — a
  // restorable sibling); alpha's sits after it with different bytes (drift).
  const past = new Date(Date.now() - 60_000)
  utimesSync(beta, past, past)
  await sleep(20)
  writeFileSync(alpha, 'alpha-HAND\n')
  const future = new Date(Date.now() + 5_000)
  utimesSync(alpha, future, future)
  const drift = (await control({ subtype: 'rewind_session', user_message_id: turn1, mode: 'code' })) as Receipt | undefined
  check("the restore refuses 'drift' NAMING alpha", drift?.outcome === 'refused' && drift.refusal === 'drift' && (drift.detail ?? '').includes('alpha.txt'), j(drift))
  check('…the hand edit survives (nothing was restored)', readFileSync(alpha, 'utf8') === 'alpha-HAND\n', readFileSync(alpha, 'utf8'))
  check('…and the sibling beta was NOT restored either (all or nothing)', readFileSync(beta, 'utf8') === 'beta-1\n', readFileSync(beta, 'utf8'))
  // Reconcile the way an operator does: a normal hand edit (fresh clock).
  // The session's next tool turn READS before it writes (the edit tools'
  // own law), which is exactly how its read-state catches up.
  writeFileSync(alpha, 'alpha-2\n')
}

// ── §5 conversation ─────────────────────────────────────────────────────────
section('§5 — conversation: the record lands in THIS transcript and the next model call is the classic truncation')
{
  const rowsBefore = readTranscriptRows().length
  const dry = (await control({ subtype: 'rewind_session', user_message_id: turn2, mode: 'conversation', dry_run: true })) as Receipt | undefined
  check('a conversation dry run names the boundary and appends nothing', dry?.outcome === 'applied' && dry.conversation?.turnUuid === turn2 && readTranscriptRows().length === rowsBefore, j(dry))
  const applied = (await control({ subtype: 'rewind_session', user_message_id: turn2, mode: 'conversation' })) as Receipt | undefined
  check('the conversation rewind answers applied with the turn boundary', applied?.outcome === 'applied' && applied.conversation?.turnUuid === turn2 && (applied.conversation.removed ?? 0) >= 2, j(applied))
  const rows = readTranscriptRows()
  check('the record persisted to THIS session\'s transcript (same id, same file — append-only)', rows.length > rowsBefore && rows.some(l => l.includes('mercury-rewind-record') && l.includes(turn2)), `rows ${rowsBefore} → ${rows.length}`)
  check('…and turn 2\'s own row is still there (nothing deleted)', rows.some(l => l.includes('turn two: set alpha again')))
  const callsBefore = fixture.messageRequests().length
  const turn3 = randomUUID()
  const r3 = await turn('turn three: after the rewind', turn3)
  check('the next turn ran', r3?.subtype === 'success', j({ s: r3?.subtype }))
  const request = fixture.messageRequests()[callsBefore]
  const body = j(request?.body ?? {})
  check('the model saw the first turn', body.includes('turn one: set alpha and beta'))
  check('…and NOT the rewound turn (the classic truncation — the abandoned turn left the model\'s view)', !body.includes('turn two: set alpha again') && !body.includes('TURN-TWO-DONE'), body.slice(0, 300))
  check('…nor the record itself (the operator\'s rewind is not narrated to the model)', !body.includes('mercury-rewind-record'))
  check('…and it saw the new prompt', body.includes('turn three: after the rewind'))
}

// ── §6 both ─────────────────────────────────────────────────────────────────
section('§6 — both: the files and the boundary in one receipt')
{
  const turn4 = randomUUID()
  const r4 = await turn('turn four: set alpha to four', turn4)
  check('turn four settled with alpha at four', r4?.subtype === 'success' && readFileSync(alpha, 'utf8') === 'alpha-4\n', `${r4?.subtype} ${readFileSync(alpha, 'utf8')}`)
  const both = (await control({ subtype: 'rewind_session', user_message_id: turn4, mode: 'both' })) as Receipt | undefined
  check('one receipt carries the files AND the boundary', both?.outcome === 'applied' && both.mode === 'both' && both.code?.filesChanged.length === 1 && both.conversation?.turnUuid === turn4, j(both))
  check('alpha is back to its state when turn four began', readFileSync(alpha, 'utf8') === 'alpha-2\n', readFileSync(alpha, 'utf8'))
  const rows = readTranscriptRows()
  check('the transcript keeps every row and holds the second record', rows.filter(l => l.includes('mercury-rewind-record')).length === 2 && rows.some(l => l.includes('turn four: set alpha to four')))
  const callsBefore = fixture.messageRequests().length
  const r5 = await turn('turn five: after both', randomUUID())
  const body = j(fixture.messageRequests()[callsBefore]?.body ?? {})
  check('the model\'s next call excludes turn four and keeps turn three', r5?.subtype === 'success' && !body.includes('turn four: set alpha to four') && body.includes('turn three: after the rewind'), body.slice(0, 300))
}

child.stdin.end()
const exit = await exited
check('the runner exited clean', exit === 0, `exit=${exit} stderr=${stderr.slice(-300)}`)
await fixture.close()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REWIND RESTORE PROOFS PASS')
else console.log(`❌ ${failures} REWIND RESTORE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
