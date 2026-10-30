#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'idiom-backpressure-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A fast producer + slow subscriber: bounded publishes, byte-exact final')
{
  let pending: (() => void) | null = null
  let clock = 0
  let commits = 0
  let lastSeen: string | null = null
  const tail = createStreamingTailStore({
    now: () => clock,
    setTimer: fn => { pending = fn; return 1 },
    clearTimer: () => { pending = null },
  })
  tail.subscribe(() => { commits++; lastSeen = tail.getSnapshot() })
  for (let i = 1; i <= 500; i++) {
    tail.update(cur => (cur ?? '') + 'x')
    if (i % 32 === 0) {
      clock += 32
      ;(pending as (() => void) | null)?.()
    }
  }
  clock += 32
  ;(pending as (() => void) | null)?.()
  check('the live tail bounds commits below the delta count', commits > 0 && commits < 30, String(commits))
  check('the final publish is byte-exact', lastSeen === 'x'.repeat(500) && tail.read() === lastSeen)
  tail.update(() => null)
  check('settlement publishes immediately and preserves the final text', tail.getSnapshot() === null && tail.readSettled() === 'x'.repeat(500))
  tail.dispose()
  check('disposal leaves no trailing timer', pending === null)
}

section('§C 200 rapid settlements collapse in-queue; final state lands intact')
{
  await import('../../src/tasks.js')
  const { recordTranscript, settleTranscriptMessage, getProject, setSessionFileForTesting } = await import(
    '../../src/utils/sessionStorage/writer.js'
  )
  const { createAssistantMessage } = await import('../../src/utils/messages/factories.js')
  const file = join(HOME, 'backpressure.jsonl')
  setSessionFileForTesting(file)
  const msg = createAssistantMessage({ content: 'streaming turn' })
  await recordTranscript([msg] as never)
  for (let i = 1; i <= 200; i++) {
    ;(msg.message.usage as { output_tokens: number }).output_tokens = i
    await settleTranscriptMessage(msg as never)
  }
  await getProject().flush()
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.includes(msg.uuid))
  check(`intermediates collapsed: ${lines.length} line(s) for 200 settlements (≤2)`, lines.length <= 2, String(lines.length))
  const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
  const entries = decodeTranscriptBuffer<{ uuid?: string; message?: { usage?: { output_tokens?: number } } }>(
    readFileSync(file),
  ).entries.filter(e => e.uuid === msg.uuid)
  check('the final settlement is intact (output_tokens=200)', entries.at(-1)?.message?.usage?.output_tokens === 200)
}

console.log(failures === 0 ? '\n ✅ BOUNDED SUBSCRIBERS PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
