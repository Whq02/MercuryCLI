#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'notice-clock-home-'))
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const FRAMES = argAfter('--frames')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const local = (h: number, m: number, s: number): Date => new Date(2026, 8, 27, h, m, s)
const OWNER_FIRST = local(20, 21, 24)
const COMPLETED = local(20, 21, 56)
const OWNER_SECOND = local(20, 22, 6)
const DELIVERED = local(20, 24, 21)
const NEARBY = local(20, 24, 0)
const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
const clockOf = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const iso = (d: Date): string => d.toISOString()

const LANE_SUMMARY = 'Agent "Lane opus-max-stall (Astra max)" completed'
const taskNotice = (summary: string): string => `<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`
const NOTE = taskNotice(LANE_SUMMARY)
const FIRST_LINE = 'the first line typed while the lead was mid-request'
const SECOND_LINE = 'the second line, forty seconds later'

const RealDate = Date
function freezeClock(at: Date): () => void {
  const atMs = at.getTime()
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(atMs)
      else if (args.length === 1) super(args[0] as number)
      else super(args[0] as number, args[1] as number, (args[2] ?? 1) as number, (args[3] ?? 0) as number, (args[4] ?? 0) as number, (args[5] ?? 0) as number, (args[6] ?? 0) as number)
    }
    static override now(): number {
      return atMs
    }
  }
  globalThis.Date = FrozenDate as DateConstructor
  return () => {
    globalThis.Date = RealDate
  }
}

const { createAttachmentMessage } = await import(join(ROOT, 'src/utils/attachments/orchestrator.ts'))
const notices = await import(join(ROOT, 'src/services/engine-connector/queuedNotices.ts'))
type Row = { type: 'attachment'; uuid: string; timestamp: string; queued?: true; attachment: { type: string; prompt: string; commandMode: string; sentAt?: string; deliveredAt?: string } }

section('§1 the record: a drained notice row is stamped where it sits — its completion — and keeps the delivery beside it')
const thaw = freezeClock(DELIVERED)
const ownerFirst = createAttachmentMessage({ type: 'queued_command', prompt: FIRST_LINE, commandMode: 'prompt', sentAt: iso(OWNER_FIRST) } as never) as Row
const completion = createAttachmentMessage({ type: 'queued_command', prompt: NOTE, commandMode: 'task-notification', sentAt: iso(COMPLETED) } as never) as Row
const ownerSecond = createAttachmentMessage({ type: 'queued_command', prompt: SECOND_LINE, commandMode: 'prompt', sentAt: iso(OWNER_SECOND) } as never) as Row
const bareNotice = createAttachmentMessage({ type: 'queued_command', prompt: NOTE, commandMode: 'task-notification' } as never) as Row
const nearby = createAttachmentMessage({ type: 'queued_command', prompt: NOTE, commandMode: 'task-notification', sentAt: iso(NEARBY) } as never) as Row
thaw()
check("RED ON THE BASE (L24): the completion notice's row is stamped at the completion it sits at, never the delivery", completion.timestamp === iso(COMPLETED), `timestamp=${completion.timestamp} wanted=${iso(COMPLETED)}`)
check('RED ON THE BASE: the delivery clock rides the record beside the completion', completion.attachment.deliveredAt === iso(DELIVERED) && completion.attachment.sentAt === iso(COMPLETED), JSON.stringify(completion.attachment))
check("the owner's drained lines keep their send clocks as their stamps (byte-identical to before)", ownerFirst.timestamp === iso(OWNER_FIRST) && ownerSecond.timestamp === iso(OWNER_SECOND), `${ownerFirst.timestamp} ${ownerSecond.timestamp}`)
check("the owner's drained lines record the same delivery clock", ownerFirst.attachment.deliveredAt === iso(DELIVERED) && ownerSecond.attachment.deliveredAt === iso(DELIVERED), JSON.stringify([ownerFirst.attachment.deliveredAt, ownerSecond.attachment.deliveredAt]))
check('a notice without a send clock is stamped at its making and records no delivery clock', bareNotice.timestamp === iso(DELIVERED) && bareNotice.attachment.deliveredAt === undefined, JSON.stringify({ timestamp: bareNotice.timestamp, attachment: bareNotice.attachment }))
check('an unparseable send clock never becomes the stamp', (createAttachmentMessage({ type: 'queued_command', prompt: NOTE, commandMode: 'task-notification', sentAt: 'not a clock' } as never) as Row).attachment.deliveredAt === undefined)

section('§2 the strip: the owner\'s exact shape paints in order with stamps that never decrease (178 and 80 columns)')
const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { Box } = await import(join(ROOT, 'src/ink.ts'))
const { AttachmentMessage } = await import(join(ROOT, 'src/components/messages/AttachmentMessage.tsx'))
const { MessageMetaProvider } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 200): Promise<void> => new Promise(r => setTimeout(r, ms))

async function paintStrip(rows: Row[], columns: number): Promise<string[]> {
  let written = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    }),
    { columns, rows: columns === 178 ? 51 : 21, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const body = h(
    Box as never,
    { flexDirection: 'column' },
    ...rows.map((row, i) =>
      h(
        MessageMetaProvider as never,
        { key: String(i), message: { type: row.type, timestamp: row.timestamp, ...(row.queued === true ? { queued: true } : {}) } },
        h(AttachmentMessage as never, { attachment: row.attachment, addMargin: i > 0, verbose: false }),
      ),
    ),
  )
  const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, body), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  await settle()
  const frame = strip(instance.lastFrame?.() ?? written)
  instance.unmount?.()
  await settle(50)
  return frame.split('\n').map(l => l.replace(/\s+$/, ''))
}

const CLOCK_HEAD = /^(\d{2}:\d{2}:\d{2}) /
const stampsOf = (lines: string[]): string[] => lines.flatMap(l => {
  const stamp = CLOCK_HEAD.exec(l)?.[1]
  return stamp === undefined ? [] : [stamp]
})
const nonDecreasing = (stamps: string[]): boolean => stamps.every((s, i) => i === 0 || s >= stamps[i - 1]!)
const oneLine = (lines: string[]): string => lines.join(' ').replace(/\s+/g, ' ')

const strip3 = [ownerFirst, completion, ownerSecond]
for (const columns of [178, 80]) {
  const lines = await paintStrip(strip3, columns)
  if (FRAMES !== undefined) writeFileSync(join(FRAMES, `strip-${columns}.txt`), lines.join('\n') + '\n')
  const stamps = stampsOf(lines)
  check(`${columns} columns: three stamped rows, one clock each`, stamps.length === 3, JSON.stringify(stamps))
  check(`${columns} columns: RED ON THE BASE (L24) — the stamps read ${clockOf(OWNER_FIRST)}, ${clockOf(COMPLETED)}, ${clockOf(OWNER_SECOND)} top to bottom`, JSON.stringify(stamps) === JSON.stringify([clockOf(OWNER_FIRST), clockOf(COMPLETED), clockOf(OWNER_SECOND)]), JSON.stringify(stamps))
  check(`${columns} columns: walking the strip top to bottom, no row is stamped later than the rows under it`, nonDecreasing(stamps), JSON.stringify(stamps))
  const noticeLine = lines.find(l => l.includes('● Agent')) ?? ''
  check(`${columns} columns: the notice row reads its completion, then the delivery as a suffix: "${clockOf(COMPLETED)} ● ${LANE_SUMMARY} · delivered ${clockOf(DELIVERED)}"`, oneLine(lines).includes(`${clockOf(COMPLETED)} ● ${LANE_SUMMARY} · delivered ${clockOf(DELIVERED)}`), noticeLine)
  check(`${columns} columns: the old "· completed" suffix is gone`, !oneLine(lines).includes('· completed'), noticeLine)
  check(`${columns} columns: the owner's lines keep the handle and the caret at their send clocks`, oneLine(lines).includes(`${clockOf(OWNER_FIRST)} [sam] ❯ ${FIRST_LINE}`) && oneLine(lines).includes(`${clockOf(OWNER_SECOND)} [sam] ❯ ${SECOND_LINE}`), oneLine(lines))
  check(`${columns} columns: every line fits the width`, lines.every(l => [...l].length <= columns), String(Math.max(...lines.map(l => [...l].length))))
}

{
  const lines = await paintStrip([nearby], 178)
  check('a delivery inside the minute paints the stamp alone (no suffix)', oneLine(lines).includes(`${clockOf(NEARBY)} ● ${LANE_SUMMARY}`) && !oneLine(lines).includes('delivered'), oneLine(lines))
  const bare = await paintStrip([bareNotice], 178)
  check('a notice with no send clock paints the clock of its making alone', oneLine(bare).includes(`${clockOf(DELIVERED)} ● ${LANE_SUMMARY}`) && !oneLine(bare).includes('delivered'), oneLine(bare))
  const held = await paintStrip([{ ...completion, queued: true }], 178)
  if (FRAMES !== undefined) writeFileSync(join(FRAMES, 'held-178.txt'), held.join('\n') + '\n')
  check("the held row is the same hold shown honestly: 'held since <completion>' and no delivery suffix", oneLine(held).includes(`held since ${clockOf(COMPLETED)} ● ${LANE_SUMMARY}`) && !oneLine(held).includes('delivered'), oneLine(held))
}

section("§3 the seat's echo row: taken keeps its arrival clock, the delivery rides the suffix; the landing test reads the delivery")
{
  const arrival = local(20, 21, 57)
  const born = notices.createNoticeRow(NOTE, arrival.getTime()) as Row
  check('born queued at its arrival clock, the arrival kept as its send clock', born.queued === true && born.timestamp === iso(arrival) && born.attachment.sentAt === iso(arrival))
  const takenRow = typeof notices.deliveredNoticeRow === 'function' ? (notices.deliveredNoticeRow(born, DELIVERED.getTime()) as Row) : null
  check('RED ON THE BASE: a taken notice keeps its arrival clock as its stamp and records the take as its delivery', takenRow !== null && takenRow.timestamp === iso(arrival) && takenRow.attachment.deliveredAt === iso(DELIVERED) && takenRow.attachment.sentAt === iso(arrival), JSON.stringify(takenRow))
  if (takenRow !== null) {
    const { queued: _queued, ...taken } = takenRow
    void _queued
    const lines = await paintStrip([taken as Row], 178)
    check(`the taken echo paints "${clockOf(arrival)} ● ${LANE_SUMMARY} · delivered ${clockOf(DELIVERED)}"`, oneLine(lines).includes(`${clockOf(arrival)} ● ${LANE_SUMMARY} · delivered ${clockOf(DELIVERED)}`), oneLine(lines))
    const landedAt = local(20, 24, 0).getTime()
    check('RED ON THE BASE: the runner\'s drained row, stamped at the completion, still lands a send the seat saw later (the landing test reads the delivery)', notices.noticeRowLanded(completion as never, NOTE, landedAt))
    const stale = { ...completion, attachment: { ...completion.attachment, deliveredAt: iso(local(20, 20, 0)) } }
    check('a row delivered before the send never lands it (no old-history row)', !notices.noticeRowLanded(stale as never, NOTE, landedAt))
    const legacy = { ...completion, timestamp: iso(local(20, 20, 0)), attachment: { type: 'queued_command', prompt: NOTE, commandMode: 'task-notification' } }
    check('a row without a delivery clock is judged by its stamp, as before', !notices.noticeRowLanded(legacy as never, NOTE, landedAt) && notices.noticeRowLanded({ ...legacy, timestamp: iso(DELIVERED) } as never, NOTE, landedAt))
  }
}

console.log(`\nprove-notice-clock: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
