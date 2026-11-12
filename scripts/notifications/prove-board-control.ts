#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'board-control-'))
const crewDir = join(scratch, 'crew')
mkdirSync(crewDir, { recursive: true })

type Rpc = Record<string, unknown>
const sent: Array<{ req: Rpc; opts: unknown }> = []
let script: Array<Rpc | Error> = []
const actualSocket = await import('../../src/daemon/controlSocket.ts')
mock.module(join(ROOT, 'src/daemon/controlSocket.ts'), () => ({
  ...actualSocket,
  daemonControlRpc: async (req: Rpc, opts: unknown) => {
    sent.push({ req, opts })
    const next = script.shift()
    if (next === undefined) throw new Error('the proof scripted no reply')
    if (next instanceof Error) throw next
    return next
  },
}))
const { executeBoardControl } = await import('../../src/services/concourse/boardControl.ts')
const obligations = await import('../../src/services/crew/obligations.ts')

const play = async (replies: Array<Rpc | Error>, decision: Parameters<typeof executeBoardControl>[0]) => {
  sent.length = 0
  script = [...replies]
  const receipt = await executeBoardControl(decision, { crewDir })
  return { receipt, requests: sent.map(s => s.req), opts: sent.map(s => s.opts) }
}
const j = (value: unknown): string => JSON.stringify(value)

console.log('§1 pause and resume: one sessionControl a call, and the daemon\'s answer read as it is')
{
  const pause = await play([{ ok: true, outcome: 'applied', detail: 'paused after this turn' }], { verb: 'session.pause', sessionId: 's-1', by: 'operator', reason: 'operator pause after turn', clientOpId: 'op-1' })
  check('pause sends sessionControl/pause with the session, who asked, the reason and the op id', j(pause.requests) === j([{ op: 'sessionControl', action: 'pause', sessionId: 's-1', by: 'operator', reason: 'operator pause after turn', clientOpId: 'op-1' }]), j(pause.requests))
  check('…under a 15 s answer ceiling', j(pause.opts) === j([{ timeoutMs: 15_000 }]), j(pause.opts))
  check('…and the receipt carries the daemon\'s outcome and words on the session', j(pause.receipt) === j({ verb: 'session.pause', objectRef: 's-1', outcome: 'applied', detail: 'paused after this turn' }), j(pause.receipt))
  const resume = await play([{ ok: true, outcome: 'noop', detail: 'was not paused' }], { verb: 'session.resume', sessionId: 's-1', by: 'operator' })
  check('resume sends sessionControl/resume with no reason and no op id when none was minted', j(resume.requests) === j([{ op: 'sessionControl', action: 'resume', sessionId: 's-1', by: 'operator' }]), j(resume.requests))
  check('…and a noop stays a noop', resume.receipt.outcome === 'noop' && resume.receipt.detail === 'was not paused', j(resume.receipt))
  const bare = await play([{ ok: true }], { verb: 'session.pause', sessionId: 's-1', by: 'operator', reason: 'r' })
  check('an ok answer that names no outcome reads applied', bare.receipt.outcome === 'applied' && bare.receipt.detail === undefined, j(bare.receipt))
  const lost = await play([{ ok: false, code: 'ETIMEOUT' }], { verb: 'session.pause', sessionId: 's-1', by: 'operator', reason: 'r' })
  check('a daemon that did not answer in time is FAILED, never refused (the same op id may be replayed)', lost.receipt.outcome === 'failed' && lost.receipt.detail === 'the daemon did not answer', j(lost.receipt))
  const gone = await play([{ ok: false, code: 'ENOCONN' }], { verb: 'session.resume', sessionId: 's-1', by: 'operator' })
  check('…and so is one that is not there', gone.receipt.outcome === 'failed' && gone.receipt.detail === 'the daemon did not answer', j(gone.receipt))
  const refused = await play([{ ok: false, error: 'no such session' }], { verb: 'session.pause', sessionId: 's-1', by: 'operator', reason: 'r' })
  check('a refusal keeps the daemon\'s own words', refused.receipt.outcome === 'refused' && refused.receipt.detail === 'no such session', j(refused.receipt))
  const wordless = await play([{ ok: false }], { verb: 'session.pause', sessionId: 's-1', by: 'operator', reason: 'r' })
  check('a refusal with no words says so', wordless.receipt.outcome === 'refused' && wordless.receipt.detail === 'daemon refused', j(wordless.receipt))
  const thrown = await play([new Error('socket closed')], { verb: 'session.pause', sessionId: 's-1', by: 'operator', reason: 'r' })
  check('a throw from the socket is a failed receipt, not a throw', thrown.receipt.outcome === 'failed' && thrown.receipt.detail === 'daemon unreachable — socket closed', j(thrown.receipt))
}

console.log('§2 redirect: a message to a session is one sessionDispatch aimed at it')
{
  const sentTo = await play([{ ok: true, state: 'working' }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'focus the tests', by: 'operator' })
  check('it sends the instruction as the prompt, no workspace, the target and who asked', j(sentTo.requests) === j([{ op: 'sessionDispatch', clientMessageId: 'm-1', prompt: 'focus the tests', workspaceDir: '', targetSessionId: 's-2', by: 'operator' }]), j(sentTo.requests))
  check('…and reads an ok as delivered, with the state the daemon named', j(sentTo.receipt) === j({ verb: 'session.redirect', objectRef: 's-2', outcome: 'applied', detail: 'instruction delivered (working)' }), j(sentTo.receipt))
  const stateless = await play([{ ok: true }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('an ok with no state reads working', stateless.receipt.detail === 'instruction delivered (working)', j(stateless.receipt))
  const held = await play([{ ok: false, state: 'queued', heldReason: 'session-paused' }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('a hold the daemon queued behind is QUEUED with its reason, not refused', held.receipt.outcome === 'queued' && held.receipt.detail === 'instruction queued (session-paused) — it delivers when the hold lifts', j(held.receipt))
  const queuedNoReason = await play([{ ok: false, state: 'queued', error: 'held' }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('queued without a held reason is a refusal in the daemon\'s words', queuedNoReason.receipt.outcome === 'refused' && queuedNoReason.receipt.detail === 'held', j(queuedNoReason.receipt))
  const lost = await play([{ ok: false, code: 'ENOCONN' }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('a daemon that is not there is FAILED', lost.receipt.outcome === 'failed' && lost.receipt.detail === 'the daemon did not answer', j(lost.receipt))
  const paused = await play([{ ok: false, error: 'session-paused: resume it first' }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('a paused target\'s refusal starts with the word the board reads to keep the draft', paused.receipt.outcome === 'refused' && String(paused.receipt.detail).startsWith('session-paused'), j(paused.receipt))
  const wordless = await play([{ ok: false }], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('a refusal with no words says so', wordless.receipt.detail === 'dispatch refused', j(wordless.receipt))
  const thrown = await play([new Error('socket closed')], { verb: 'session.redirect', sessionId: 's-2', clientMessageId: 'm-1', instruction: 'x', by: 'operator' })
  check('a throw from the socket is a failed receipt', thrown.receipt.outcome === 'failed' && thrown.receipt.detail === 'daemon unreachable — socket closed', j(thrown.receipt))
}

console.log('§3 answer: the reply is delivered to the session first, and only then is the question settled')
{
  const raise = async (ref: string, sessionId: string): Promise<string> =>
    (await obligations.upsertObligation({ ref, sessionId, question: `the question of ${ref}`, owner: 'operator', scope: 'switchboard', dir: crewDir })).obligationId
  const statusOf = async (obligationId: string): Promise<string | undefined> => (await obligations.obligationOf(obligationId, { dir: crewDir, scope: 'switchboard' }))?.status

  const first = await raise('fx:answer', 's-3')
  const delivered = await play([{ ok: true, state: 'working' }], { verb: 'obligation.answer', obligationId: first, sessionId: 's-3', clientMessageId: 'a-1', answer: 'use the second plan', by: 'operator' })
  check('it sends the answer as a prompt aimed at the asking session', j(delivered.requests) === j([{ op: 'sessionDispatch', clientMessageId: 'a-1', prompt: 'use the second plan', workspaceDir: '', targetSessionId: 's-3', by: 'operator' }]), j(delivered.requests))
  check('…reads the delivery and the settlement in one receipt on the question', j(delivered.receipt) === j({ verb: 'obligation.answer', objectRef: first, outcome: 'applied', detail: 'answer delivered (working) · obligation settled' }), j(delivered.receipt))
  check('…and the question is answered in the store', (await statusOf(first)) === 'answered', String(await statusOf(first)))
  const again = await play([{ ok: true, state: 'working' }], { verb: 'obligation.answer', obligationId: first, sessionId: 's-3', clientMessageId: 'a-1', answer: 'use the second plan', by: 'operator' })
  check('a second answer to a settled question is a noop that says what it found', again.receipt.outcome === 'noop' && again.receipt.detail === 'answer delivered (working) · already answered', j(again.receipt))

  const pictured = await raise('fx:pictured', 's-3')
  const content = [{ type: 'text', text: 'see this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
  const withContent = await play([{ ok: true }], { verb: 'obligation.answer', obligationId: pictured, sessionId: 's-3', clientMessageId: 'a-2', answer: 'see this', content, by: 'operator' })
  check('content blocks ride the dispatch when there are any', j(withContent.requests[0]?.content) === j(content), j(withContent.requests[0]))
  const emptied = await raise('fx:emptied', 's-3')
  const withEmpty = await play([{ ok: true }], { verb: 'obligation.answer', obligationId: emptied, sessionId: 's-3', clientMessageId: 'a-3', answer: 'plain', content: [], by: 'operator' })
  check('…and an empty list sends no content field', !('content' in (withEmpty.requests[0] ?? {})), j(withEmpty.requests[0]))

  const replayed = await raise('fx:replayed', 's-3')
  const hops = await play([{ ok: false, replay: 'failed-before', state: 'failed', stateRevision: 3 }, { ok: true, state: 'working' }], { verb: 'obligation.answer', obligationId: replayed, sessionId: 's-3', clientMessageId: 'a-4', answer: 'again', by: 'operator' })
  check('a delivery id the daemon already failed is re-minted from its revision and sent once more', hops.requests.length === 2 && hops.requests[1]?.clientMessageId === 'a-4:r3' && hops.receipt.outcome === 'applied', j(hops.requests.map(r => r.clientMessageId)))
  const wall = await raise('fx:wall', 's-3')
  const exhausted = await play(Array.from({ length: 5 }, (_, n) => ({ ok: false, replay: 'failed-before', state: 'failed', stateRevision: n })), { verb: 'obligation.answer', obligationId: wall, sessionId: 's-3', clientMessageId: 'a-5', answer: 'again', by: 'operator' })
  check('five replays and the chain ends refused, the question still open', exhausted.requests.length === 5 && exhausted.receipt.outcome === 'refused' && exhausted.receipt.detail === 'delivery retry chain exhausted — the target keeps refusing' && (await statusOf(wall)) === 'open', `${j(exhausted.receipt)} ${await statusOf(wall)}`)

  const unanswered = await raise('fx:lost', 's-3')
  const lost = await play([{ ok: false, code: 'ETIMEOUT' }], { verb: 'obligation.answer', obligationId: unanswered, sessionId: 's-3', clientMessageId: 'a-6', answer: 'x', by: 'operator' })
  check('a daemon that did not answer leaves the question OPEN and says the retry replays', lost.receipt.outcome === 'failed' && lost.receipt.detail === 'the daemon did not answer — the retry replays the same delivery' && (await statusOf(unanswered)) === 'open', `${j(lost.receipt)} ${await statusOf(unanswered)}`)
  const refused = await play([{ ok: false, error: 'session ended' }], { verb: 'obligation.answer', obligationId: unanswered, sessionId: 's-3', clientMessageId: 'a-6', answer: 'x', by: 'operator' })
  check('a refused delivery leaves the question OPEN with the daemon\'s words', refused.receipt.outcome === 'refused' && refused.receipt.detail === 'session ended' && (await statusOf(unanswered)) === 'open', `${j(refused.receipt)} ${await statusOf(unanswered)}`)
  const thrown = await play([new Error('socket closed')], { verb: 'obligation.answer', obligationId: unanswered, sessionId: 's-3', clientMessageId: 'a-6', answer: 'x', by: 'operator' })
  check('a throw from the socket is a failed receipt and the question stays open', thrown.receipt.outcome === 'failed' && thrown.receipt.detail === 'daemon unreachable — socket closed' && (await statusOf(unanswered)) === 'open', j(thrown.receipt))

  const stranded = await raise('kernel:capacity:cm-9', 'dispatch:cm-9')
  const noSession = await play([], { verb: 'obligation.answer', obligationId: stranded, sessionId: 'dispatch:cm-9', clientMessageId: 'a-7', answer: 'retry it', by: 'operator' })
  check('a question raised for a dispatch that never became a session is refused before any call, and stays open', noSession.requests.length === 0 && noSession.receipt.outcome === 'refused' && String(noSession.receipt.detail).startsWith('this question has no session to deliver to') && (await statusOf(stranded)) === 'open', `${j(noSession.receipt)} ${await statusOf(stranded)}`)
}

console.log('§4 the board and the hosted chat reach the daemon through this one executor')
{
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  const calls = (text: string): number => text.split('control.executeBoardControl(').length - 1
  check('the board\'s answer, pause, resume and redirect each call it once', calls(route) === 4 && ["verb: 'obligation.answer'", "verb: 'session.pause'", "verb: 'session.resume'", "verb: 'session.redirect'"].every(verb => route.includes(verb)), String(calls(route)))
  check('the hosted chat\'s answer to an open question calls it once', calls(connector) === 1 && connector.includes("const control = await import('../concourse/boardControl.js')"), String(calls(connector)))
  const concourse = join(ROOT, 'src', 'services', 'concourse')
  const holders = readdirSync(concourse).filter(name => readFileSync(join(concourse, name), 'utf8').includes('instruction delivered ('))
  check('the delivery words stand in one file under the concourse services', j(holders) === j(['boardControl.ts']), j(holders))
}

console.log('§5 zero provider surface (the executor\'s import closure)')
{
  const banned = /services\/providers\/|utils\/model\/|streamModel|run-core\/turn-machine|api\/|anthropic|openai/i
  const seen = new Set<string>()
  const queue = ['src/services/concourse/boardControl.ts']
  const offenders: string[] = []
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let src = ''
    try {
      src = read(file)
    } catch {
      continue
    }
    for (const m of src.matchAll(/import\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (!spec.startsWith('.')) continue
      const base = join(file, '..', spec).replace(/\.js$/, '.ts')
      if (banned.test(base)) offenders.push(`${file} → ${spec}`)
      else queue.push(base)
    }
  }
  check('the closure holds no provider or model module', offenders.length === 0, offenders.join('; '))
  check('the closure was walked (not vacuous)', seen.size >= 3, `${seen.size} modules`)
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-BOARD-CONTROL: PASS' : `\nPROVE-BOARD-CONTROL: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
