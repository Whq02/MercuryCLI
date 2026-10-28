#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-carry-identity-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const cwd = join(scratch, 'project')
mkdirSync(cwd)
process.chdir(cwd)

let failures = 0
let checks = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

try {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { setOriginalCwd, setCwdState } = await import('../../src/bootstrap/state.ts')
  setOriginalCwd(cwd)
  setCwdState(cwd)
  const q = await import('../../src/input-core/command-queue.ts')
  const lr = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
  const carry = await import('../../src/cli/headless/restartCarry.ts')
  const { flushSessionStorage, recordTranscript } = await import('../../src/utils/sessionStorage.ts')
  const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
  const { getTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')

  const journalLines = async (): Promise<string[]> => {
    await recordTranscript([createUserMessage({ content: 'a real message materializes the file' })])
    await flushSessionStorage()
    const path = getTranscriptPath()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (existsSync(path) && readFileSync(path, 'utf8').includes('queue-operation')) break
      await new Promise(r => setTimeout(r, 100))
    }
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  }
  const journalRows = async (): Promise<Array<{ operation: string; uuid?: string; content?: string }>> =>
    lr.queueLogRows(await journalLines()).map(r => ({ operation: r.operation, ...(r.uuid !== undefined ? { uuid: r.uuid } : {}), ...(r.content !== undefined ? { content: r.content } : {}) }))

  section('R1 the journal of a line taken ahead of a waiting notice names the line it took')
  const noticeUuid = randomUUID()
  const lineUuid = randomUUID()
  const sentAt = '2026-10-28T19:41:30.100Z'
  q.resetCommandQueue()
  q.enqueuePendingNotification({ value: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>', mode: 'task-notification', uuid: noticeUuid as never })
  q.enqueue({ value: '/compact', mode: 'prompt', uuid: lineUuid as never, sentAt })
  const taken = q.dequeue(cmd => cmd.agentId === undefined)
  check('the driver takes the operator\'s line first (the priority law: next before later)', taken?.uuid === lineUuid, j(taken?.uuid))
  check('the notice still waits in the queue', q.getCommandQueue().length === 1 && q.getCommandQueue()[0]!.uuid === noticeUuid)
  const rows = await journalRows()
  const take = rows.find(r => r.operation === 'dequeue')
  check('the dequeue row names the identity it took', take !== undefined && take.uuid === lineUuid, j(rows))

  section('R2 the restart carry re-delivers nothing from that journal')
  const lines = await journalLines()
  const pending = lr.pendingQueueLogRows(lr.queueLogRows(lines))
  check('the pending view holds the notice alone, never the taken line', pending.length === 1 && pending[0]!.uuid === noticeUuid, j(pending.map(r => r.uuid)))
  const undelivered = lr.undeliveredLines(lr.queueLogRows(lines))
  check('no operator line reads as undelivered', undelivered.length === 0, j(undelivered))
  q.resetCommandQueue()
  const recovered: string[] = []
  const requeued = carry.requeueUndeliveredLines(lines, recovered)
  check('a restart re-queues nothing: the taken line never runs a second time under its old clock', requeued === 0 && recovered.length === 0 && q.getCommandQueue().length === 0, j({ requeued, recovered, queue: q.getCommandQueue().map(c => c.uuid) }))

  section('R3 every taking road names what it took')
  q.resetCommandQueue()
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  q.enqueue({ value: 'one', mode: 'prompt', uuid: ids[0] as never })
  q.enqueue({ value: 'two', mode: 'prompt', uuid: ids[1] as never })
  q.enqueue({ value: 'three', mode: 'prompt', uuid: ids[2] as never })
  q.enqueue({ value: 'four', mode: 'prompt', uuid: ids[3] as never })
  const refs = q.getCommandQueue()
  q.remove([refs[1]!, { ...refs[2]!, uuid: 'not-a-queue-reference' as never }])
  q.dequeueAllMatching(cmd => cmd.uuid === ids[2])
  q.dequeueAll()
  const all = await journalRows()
  const takes = all.filter(r => r.operation === 'dequeue' || r.operation === 'remove')
  check('remove names the removed identity and writes no row for a reference it did not find', takes.filter(r => r.operation === 'remove').map(r => r.uuid).join(',') === ids[1], j(takes))
  check('dequeueAllMatching names its match', takes.some(r => r.operation === 'dequeue' && r.uuid === ids[2]))
  check('dequeueAll names each line it took', [ids[0], ids[3]].every(id => takes.some(r => r.operation === 'dequeue' && r.uuid === id)), j(takes))
  const pendingAll = lr.pendingQueueLogRows(lr.queueLogRows(await journalLines()))
  check('the pending view of the whole journal holds only the notice no road ever took', pendingAll.map(r => r.uuid).join(',') === noticeUuid, j(pendingAll.map(r => r.uuid)))

  section('R4 an older journal (takes without identity) still folds by order')
  const envelope = (fields: Record<string, unknown>): string =>
    j({ type: 'queue-operation', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', ...fields })
  const legacy = lr.pendingQueueLogRows(lr.queueLogRows([
    envelope({ operation: 'enqueue', content: 'first', commandUuid: 'u-a', mode: 'prompt' }),
    envelope({ operation: 'dequeue' }),
    envelope({ operation: 'enqueue', content: 'second', commandUuid: 'u-b', mode: 'prompt' }),
  ]))
  check('a take without identity still takes the oldest pending line', legacy.length === 1 && legacy[0]!.uuid === 'u-b', j(legacy))
} finally {
  process.chdir('/')
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n✅ RESTART CARRY NAMES WHAT IT TOOK — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
