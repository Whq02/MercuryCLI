#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'idiom-backpressure-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { StreamBatcher } = await import('../../src/utils/messages/streamBatcher.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A fast producer + slow sink: frame-bounded commits, byte-exact final')
{
  let pending: (() => void) | null = null
  let commits = 0
  let lastSeen = ''
  const b = new StreamBatcher<string>('', {
    sink: (v: string) => {
      commits++
      lastSeen = v
    },
    intervalMs: 16,
    setTimer: (fn: () => void) => {
      pending = fn
      return 1
    },
    clearTimer: () => {
      pending = null
    },
  })

  let value = ''
  for (let i = 1; i <= 500; i++) {
    value += 'x'
    b.update(() => value)
    if (i % 16 === 0 && pending) {
      const fire = pending
      pending = null
      fire()
    }
  }
  if (pending) {
    const fire: () => void = pending
    pending = null
    fire()
  }
  b.dispose()

  check(`commits are frame-bounded: ${commits} ≪ 500 deltas`, commits > 0 && commits < 120, String(commits))
  check('the FINAL value is byte-exact (the last chunk never dropped)', lastSeen === 'x'.repeat(500), `len=${lastSeen.length}`)
}

section('§B length changes flush immediately; inner appends batch')
{
  let pending: (() => void) | null = null
  const seen: number[] = []
  const b = new StreamBatcher<string[]>([], {
    sink: (v: string[]) => seen.push(v.length),
    intervalMs: 16,
    flushNow: (prev: string[], next: string[]) => prev.length !== next.length,
    setTimer: (fn: () => void) => {
      pending = fn
      return 1
    },
    clearTimer: () => {
      pending = null
    },
  })

  let arr: string[] = []
  let updates = 0
  for (let block = 0; block < 3; block++) {
    arr = [...arr, '']
    b.update(() => arr)
    updates++
    for (let d = 0; d < 50; d++) {
      arr = [...arr.slice(0, -1), arr[arr.length - 1]! + 'y']
      b.update(() => arr)
      updates++
      if (updates % 16 === 0 && pending) {
        const fire: () => void = pending
        pending = null
        fire()
      }
    }
  }
  if (pending) {
    const fire: () => void = pending
    pending = null
    fire()
  }
  b.dispose()
  check('every length change committed immediately (3 opens present)', [1, 2, 3].every(n => seen.includes(n)), seen.join(','))
  check(`inner deltas batched: ${seen.length} commits ≪ 153 updates`, seen.length < 60, String(seen.length))
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
