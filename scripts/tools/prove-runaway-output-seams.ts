#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-runaway-output-seams.ts — THE RUNAWAY-OUTPUT LAW:
//  no external process can wedge a session. Every conversation-entering
//  seam holds a bounded excerpt whose marker names where the full bytes
//  live; an unwritable output file degrades to a loss note, never
//  unbounded memory.
//
//  The megabyte-printer fixture drives each seam with multi-megabyte
//  payloads:
//    • PROJECTION seams (attachment → API message): async-hook system
//      message + additionalContext, hook stopped-continuation, the
//      teammate mailbox (a FILE any process can write), plus the sync
//      hook_success/blocking regression pair — every projected message
//      stays under the seam cap plus envelope slack.
//    • DISK seam (DiskTaskOutput): with the output file unwritable, queued
//      content is discarded into a loss ledger (heap stays bounded — the
//      poison is the old retry-forever queue at producer scale), and the
//      healed file opens with the note naming the exact loss.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-runaway-output-seams.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Scratch homes BEFORE the module chain loads — the temp-root and project
// caches memoize on first touch.
const scratch = mkdtempSync(join(tmpdir(), 'mercury-runaway-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

const M = await import('../../src/utils/messages.ts')
const { HOOK_CONTEXT_CAP_CHARS } = await import('../../src/utils/hooks/contextBound.ts')
const { DiskTaskOutput, getTaskOutputDir, getTaskOutputPath } = await import('../../src/utils/task/diskOutput.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const MB = 1024 * 1024
const printer = (fill: string): string => fill.repeat(Math.ceil((5 * MB) / fill.length))
// The seam cap plus the envelope's own prose (reminder tags, labels, the
// omission marker with its spill path).
const CEILING = HOOK_CONTEXT_CAP_CHARS + 2000

function contentLength(message: unknown): number {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce<number>(
      (sum, block) => sum + (typeof (block as { text?: string }).text === 'string' ? (block as { text: string }).text.length : 0),
      0,
    )
  }
  return 0
}
function contentText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(block => (block as { text?: string }).text ?? '').join('')
  return ''
}

// ── PROJECTION seams under the megabyte printer ─────────────────────────────
{
  const seams: Array<[string, object]> = [
    ['async_hook_response systemMessage', {
      type: 'async_hook_response',
      processId: 'p1',
      hookName: 'flooder',
      hookEvent: 'Stop',
      response: { systemMessage: printer('async system flood ') },
    }],
    ['async_hook_response additionalContext', {
      type: 'async_hook_response',
      processId: 'p2',
      hookName: 'flooder',
      hookEvent: 'Stop',
      response: { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: printer('async context flood ') } },
    }],
    ['hook_stopped_continuation', {
      type: 'hook_stopped_continuation',
      hookName: 'flooder',
      message: printer('stop reason flood '),
    }],
    ['hook_success (regression)', {
      type: 'hook_success',
      hookName: 'flooder',
      hookEvent: 'SessionStart',
      toolUseID: 't1',
      content: printer('session start flood '),
    }],
    ['teammate_mailbox', {
      type: 'teammate_mailbox',
      messages: [
        { from: 'flooder', text: printer('mailbox flood '), timestamp: '2026-01-01T00:00:00Z' },
        { from: 'quiet', text: 'a normal short message', timestamp: '2026-01-01T00:00:01Z' },
      ],
    }],
  ]
  for (const [label, attachment] of seams) {
    const projected = M.normalizeAttachmentForAPI(attachment as never)
    check(`${label}: projects at least one message`, projected.length > 0)
    for (const message of projected) {
      const length = contentLength(message)
      check(`${label}: bounded under the seam ceiling`, length <= CEILING, `${length} chars`)
    }
    const joined = projected.map(contentText).join('\n')
    check(`${label}: the marker names the omission`,
      joined.includes('characters omitted'), joined.slice(0, 200))
  }

  // The quiet teammate's message must survive byte-identical beside the
  // bounded flooder (the bound is per message, never per mailbox).
  const mailbox = M.normalizeAttachmentForAPI(seams[4]![1] as never)
  check('teammate_mailbox: the quiet message survives whole',
    mailbox.some(message => contentText(message).includes('a normal short message')))
}

// ── DISK seam: the unwritable output file degrades, never grows ─────────────
{
  const taskId = 'runaway-disk-probe'
  const tasksDir = getTaskOutputDir()
  // Plant a FILE at the tasks DIRECTORY path: every mkdir/open in the drain
  // now fails (ENOTDIR/EEXIST) — the persistent-unwritable window.
  mkdirSync(dirname(tasksDir), { recursive: true })
  writeFileSync(tasksDir, 'the directory is a file today', 'utf8')

  const writer = new DiskTaskOutput(taskId)
  const chunk = 'x'.repeat(100 * 1024)
  const rounds = 200 // 20MB against the broken disk
  for (let i = 0; i < rounds; i++) writer.append(chunk)
  await writer.flush()
  // One in-flight batch may sit queued between appends; the ledger must
  // hold everything else. The poison (retry-forever queue) holds all 20MB.
  const pending = writer.pendingChars()
  check('unwritable window: heap stays bounded (pending ≤ one chunk)',
    pending <= chunk.length, `${pending} chars pending`)
  check('unwritable window: no output file appeared', !existsSync(getTaskOutputPath(taskId)))

  // Heal the disk; the next append drains with the loss note first.
  rmSync(tasksDir)
  writer.append('after-heal marker\n')
  await writer.flush()
  const healed = readFileSync(getTaskOutputPath(taskId), 'utf8')
  check('healed file leads with the loss note',
    /^\n<[\d,]+ characters of task output were lost: the output file was unwritable/.test(healed),
    healed.slice(0, 120))
  const lostCount = Number((/<([\d,]+) characters/.exec(healed)?.[1] ?? '0').replace(/,/g, ''))
  check('the loss note names at least the discarded volume',
    lostCount >= (rounds - 1) * chunk.length, String(lostCount))
  check('healed file carries the post-heal content', healed.includes('after-heal marker'))
}

rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0
  ? `\nrunaway output seams: green (${checks} checks)`
  : `\nrunaway output seams: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
