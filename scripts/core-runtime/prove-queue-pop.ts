#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = mkdtempSync(join(tmpdir(), 'queue-pop-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HOME, 'teams')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const q = await import('../../src/input-core/command-queue.ts')
type Cmd = Parameters<typeof q.enqueue>[0]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const uuid = (n: number): Cmd['uuid'] => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Cmd['uuid']
const cmd = (n: number, value: Cmd['value'] = `words ${n}`, mode: Cmd['mode'] = 'prompt'): Cmd => ({ value, mode, uuid: uuid(n) })

section('P1 a queued identity pops — the words come back, consumption reads popped')
{
  q.resetCommandQueue()
  const events: Array<{ kind: string; uuids: string[] }> = []
  const off = q.subscribeQueueConsumption(ev => events.push({ kind: ev.kind, uuids: ev.commands.map(c => String(c.uuid)) }))
  let changes = 0
  const offChange = q.subscribeToCommandQueue(() => changes++)
  q.enqueue(cmd(1))
  q.enqueue(cmd(2))
  q.enqueue(cmd(3))
  const before = q.getCommandQueueSnapshot()
  changes = 0
  const receipt = q.popById(String(uuid(2)))
  check('the pop answers popped with the command and its words', receipt.popped && receipt.text === 'words 2' && String(receipt.command.uuid) === String(uuid(2)), j(receipt))
  check('the command left the queue; the others keep their order and identities', q.getCommandQueue().map(c => String(c.value)).join(',') === 'words 1,words 3' && q.getCommandQueue().every(c => c.queueId !== undefined), j(q.getCommandQueue()))
  check('one queueChanged emit, a fresh frozen snapshot, the old one untouched', changes === 1 && q.getCommandQueueSnapshot() !== before && before.length === 3 && Object.isFrozen(q.getCommandQueueSnapshot()), `${changes} emits · before ${before.length}`)
  check("consumption read 'popped' for exactly that command — never 'dequeued'", events.length === 1 && events[0]!.kind === 'popped' && j(events[0]!.uuids) === j([String(uuid(2))]), j(events))
  off()
  offChange()
}

section('P2 a popped identity asked again is unknown — it never ran')
{
  const again = q.popById(String(uuid(2)))
  check("the second pop answers unknown (never 'taken': a popped line did not run)", !again.popped && again.reason === 'unknown', j(again))
}

section('P3 a taken identity answers taken — every consumption road remembers')
{
  q.resetCommandQueue()
  q.enqueue(cmd(4))
  q.enqueue(cmd(5))
  q.enqueue(cmd(6))
  q.enqueue(cmd(7))
  const dequeued = q.dequeue()
  check('the driver dequeued the first command', String(dequeued?.uuid) === String(uuid(4)))
  const takenByDriver = q.popById(String(uuid(4)))
  check("a dequeued identity answers taken", !takenByDriver.popped && takenByDriver.reason === 'taken', j(takenByDriver))
  const ref = q.getCommandQueue().find(c => String(c.uuid) === String(uuid(5)))!
  q.remove([ref])
  const takenByDrain = q.popById(String(uuid(5)))
  check("an identity the mid-turn drain removed answers taken", !takenByDrain.popped && takenByDrain.reason === 'taken', j(takenByDrain))
  const matched = q.dequeueAllMatching(c => String(c.uuid) === String(uuid(6)))
  check('dequeueAllMatching took the sixth', matched.length === 1)
  check("…and it answers taken", q.popById(String(uuid(6))).popped === false && (q.popById(String(uuid(6))) as { reason: string }).reason === 'taken')
  q.dequeueAll()
  check("dequeueAll's take answers taken", q.popById(String(uuid(7))).popped === false && (q.popById(String(uuid(7))) as { reason: string }).reason === 'taken')
  check('the queue is empty', q.getCommandQueue().length === 0)
}

section('P4 an identity the queue never held is unknown')
{
  const never = q.popById('11111111-1111-4111-8111-111111111111')
  check("a stranger's identity answers unknown", !never.popped && never.reason === 'unknown', j(never))
  const empty = q.popById('')
  check('the empty identity answers unknown', !empty.popped && empty.reason === 'unknown', j(empty))
}

section('P5 the drain window: a selected command is taken until the marks clear')
{
  q.resetCommandQueue()
  const events: string[] = []
  const off = q.subscribeQueueConsumption(ev => events.push(ev.kind))
  q.enqueue(cmd(8))
  const selected = q.getDrainableCommands(false)
  q.markDraining(selected)
  const held = q.popById(String(uuid(8)))
  check("a command the turn machine selected answers taken while the marks stand", !held.popped && held.reason === 'taken', j(held))
  check('…and it is still in the queue for the drain to remove', q.getCommandQueue().length === 1 && events.length === 0)
  q.markDraining([])
  const freed = q.popById(String(uuid(8)))
  check('once the marks clear (a drain torn down before its attachment went out) the command pops', freed.popped && freed.text === 'words 8', j(freed))
  off()
}

section('P6 the journal: one queue-operation row, operation pop, carrying the words')
{
  q.resetCommandQueue()
  q.enqueue(cmd(9, 'the words the journal keeps'))
  q.popById(String(uuid(9)))
  const { recordTranscript } = await import('../../src/utils/sessionStorage.ts')
  const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
  await recordTranscript([createUserMessage({ content: 'a real message materializes the file' })])
  const rows: Array<{ operation?: string; content?: string }> = []
  const deadline = Date.now() + 3000
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (!line.includes('queue-operation')) continue
          try {
            const raw = JSON.parse(line) as { operation?: string; content?: string; payload?: { metaKind?: string; fields?: { operation?: string; content?: string } } }
            const fields = raw.payload?.metaKind === 'queue-operation' ? raw.payload.fields : raw
            if (fields !== undefined && typeof fields.operation === 'string') rows.push({ operation: fields.operation, ...(fields.content !== undefined ? { content: fields.content } : {}) })
          } catch {
          }
        }
      }
    }
  }
  const WORDS = 'the words the journal keeps'
  while (Date.now() < deadline) {
    rows.length = 0
    walk(HOME)
    if (rows.some(r => r.operation === 'pop' && r.content === WORDS)) break
    await new Promise(r => setTimeout(r, 100))
  }
  const pops = rows.filter(r => r.operation === 'pop' && r.content === WORDS)
  check('the pop wrote exactly one journal row, operation pop, carrying the words', pops.length === 1, j(rows.filter(r => r.operation === 'pop')))
  check('the enqueue row stands beside it (the journal is append-only)', rows.some(r => r.operation === 'enqueue' && r.content === WORDS), j(rows.slice(-4)))
  check("a pop is never journaled as a dequeue (the popped words have no dequeue row after them)", !rows.slice(rows.findIndex(r => r.operation === 'enqueue' && r.content === WORDS)).some(r => r.operation === 'dequeue'), j(rows.slice(-4)))
}

section('P7 shapes: content blocks join their text; a bash line keeps its mode')
{
  q.resetCommandQueue()
  q.enqueue(cmd(10, [{ type: 'text', text: 'first block' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }, { type: 'text', text: 'second block' }] as Cmd['value']))
  q.enqueue(cmd(11, 'ls -la', 'bash'))
  const blocks = q.popById(String(uuid(10)))
  check('a content-block value pops with its text blocks joined by a newline', blocks.popped && blocks.text === 'first block\nsecond block', j(blocks))
  const bash = q.popById(String(uuid(11)))
  check('a bash-mode command keeps its mode on the popped record', bash.popped && bash.command.mode === 'bash' && bash.text === 'ls -la', j(bash))
  check('the queue is empty again', q.getCommandQueue().length === 0)
}

q.resetCommandQueue()
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-queue-pop: ALL LAWS HOLD' : `prove-queue-pop: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
