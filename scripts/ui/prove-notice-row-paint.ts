#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'notice-row-paint-home-'))
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const { noticeOfText, wrappedNoticeBlocks, noticePlate, isNotificationLaneRow, noticeLines } = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))

const WATCH = 'wave comms: lane questions and verdicts'
const monitorBlock = (task: string, name: string, body: string): string => `<monitor task=${JSON.stringify(task)} name=${JSON.stringify(name)}>\n${body}\n</monitor>`
const taskNotice = (summary: string): string => `<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`
const ESC = String.fromCharCode(27)
const BELL = String.fromCharCode(7)

section("§1 the classification: a wrapped notice, the notification lane, and the operator's own line")
{
  const one = noticeOfText(monitorBlock('bk1', WATCH, '\n==> OPUS-55.md <==\n\n18:26 · OPUS-55 · landed\n'), false)
  check('one monitor block is one monitor notice', one !== null && one.length === 1 && one[0]!.kind === 'monitor', JSON.stringify(one))
  check("the block's task and name are read back unquoted", one?.[0]?.kind === 'monitor' && one[0].taskId === 'bk1' && one[0].name === WATCH, JSON.stringify(one))
  check('blank lines are dropped, the event lines kept in order', JSON.stringify(one?.[0]?.lines) === JSON.stringify(['==> OPUS-55.md <==', '18:26 · OPUS-55 · landed']), JSON.stringify(one?.[0]?.lines))
  check('the plate names the kind and the watch', one !== null && noticePlate(one[0]!) === `monitor · ${WATCH}`, one === null ? 'null' : noticePlate(one[0]!))

  const two = noticeOfText(`${monitorBlock('bk1', WATCH, 'event-1')}${monitorBlock('bk1', WATCH, 'event-2')}`, false)
  check('two blocks of the same watch in one text fold into one plate with both lines', two !== null && two.length === 1 && JSON.stringify(two[0]!.lines) === JSON.stringify(['event-1', 'event-2']), JSON.stringify(two))
  const other = noticeOfText(`${monitorBlock('bk1', WATCH, 'event-1')}\n${monitorBlock('bk2', 'the build watch', 'built')}`, false)
  check('two watches in one text keep two plates', other !== null && other.length === 2 && other[1]!.kind === 'monitor' && other[1]!.name === 'the build watch', JSON.stringify(other))
  const empty = noticeOfText(monitorBlock('bk1', '', 'x'), false)
  check('a nameless watch plates as the bare kind word', empty !== null && noticePlate(empty[0]!) === 'monitor')

  const reminderOnly = noticeOfText('<system-reminder>Stop hook blocking error from command "lint": 3 errors</system-reminder>', false)
  check("a row that is only a system reminder is a plain notice with the reminder's lines", reminderOnly !== null && reminderOnly[0]!.kind === 'notice' && reminderOnly[0]!.lines[0] === 'Stop hook blocking error from command "lint": 3 errors', JSON.stringify(reminderOnly))
  check("a reminder followed by the operator's words is the operator's own line", noticeOfText('<system-reminder>context</system-reminder>\nfix the build please', false) === null)
  check("the operator's plain words are never a notice", noticeOfText('carried to the owner, waiting', false) === null)
  check("a line that merely starts with a tag is the operator's own", noticeOfText('<p>hello there', false) === null)
  check('an unclosed monitor block is not a notice', noticeOfText('<monitor task="a" name="b">\nhalf', false) === null)
  check('a task notification keeps its own painter', noticeOfText(taskNotice('Agent "a" completed'), true) === null)
  const lane = noticeOfText('Stop hook blocking error from command "lint": 3 errors', true)
  check('free text on the notification lane is a plain notice', lane !== null && lane[0]!.kind === 'notice' && noticePlate(lane[0]!) === 'notice', JSON.stringify(lane))
  check("the same free text off the lane is the operator's own", noticeOfText('Stop hook blocking error from command "lint": 3 errors', false) === null)
  check('an empty lane text paints nothing', noticeOfText('  \n ', true) === null)
  check('terminal controls never reach a notice line', JSON.stringify(noticeLines(`${ESC}[31mred${ESC}[0m\r\nok${BELL}`)) === JSON.stringify(['red', 'ok']), JSON.stringify(noticeLines(`${ESC}[31mred${ESC}[0m\r\nok${BELL}`)))
  check('wrappedNoticeBlocks answers null for plain words', wrappedNoticeBlocks('plain words') === null)
  check('a queued_command attachment on the task-notification lane is a lane row', isNotificationLaneRow({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification' } }))
  check('a queued_command attachment on the prompt lane is not', !isNotificationLaneRow({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt' } }))
  check('a user row carries no lane', !isNotificationLaneRow({ type: 'user' }))
}

section("§2 the painted row: the plate and the lines, never the operator's caret, never the wrapper")
const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { UserTextMessage } = await import(join(ROOT, 'src/components/messages/UserTextMessage.tsx'))
const { AttachmentMessage } = await import(join(ROOT, 'src/components/messages/AttachmentMessage.tsx'))
const { MessageMetaProvider } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 200): Promise<void> => new Promise(r => setTimeout(r, ms))
const STAMP = '2026-06-19T12:00:07.000Z'
const clockOf = (iso: string): string => {
  const d = new Date(iso)
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function paint(body: React.ReactElement, meta: { type: string; timestamp?: string; queued?: true; heldFor?: 'compaction' }): Promise<string> {
  let written = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    }),
    { columns: 100, rows: 30, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(
    h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(MessageMetaProvider as never, { message: meta }, body)),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  instance.unmount?.()
  await settle(50)
  return strip(written).replace(/\s+/g, ' ')
}

{
  const text = monitorBlock('bk1', WATCH, '\n==> OPUS-55.md <==\n\n18:26 · OPUS-55 · landed\n')
  const frame = await paint(h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text }, verbose: false }), { type: 'user', timestamp: STAMP })
  check('THE DEFECT PIN: a monitor notice taken between turns paints no operator caret', !frame.includes('❯'), frame.slice(0, 200))
  check('…and no raw wrapper', !frame.includes('<monitor') && !frame.includes('</monitor>'), frame.slice(0, 200))
  check('…the plate names the watch', frame.includes(`● monitor · ${WATCH}`), frame.slice(0, 200))
  check('…the event lines stand beneath it', frame.includes('==> OPUS-55.md <==') && frame.includes('18:26 · OPUS-55 · landed'), frame.slice(0, 240))
  check("…under the row's own clock", frame.includes(`${clockOf(STAMP)} ●`), frame.slice(0, 120))
  check("…and the operator's handle is nowhere on it", !frame.includes('[sam]'), frame.slice(0, 120))
}
{
  const text = monitorBlock('bk1', WATCH, 'event-1')
  const frame = await paint(h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification' }, addMargin: false, verbose: false }), { type: 'attachment', timestamp: STAMP, queued: true })
  check('RED on the base: a queued notice says held since its arrival, not a delivered clock', frame.includes(`held since ${clockOf(STAMP)} ● monitor · ${WATCH}`) && !frame.includes('queued') && frame.includes('event-1'), frame.slice(0, 240))
  check('…and never the caret or the wrapper', !frame.includes('❯') && !frame.includes('<monitor'), frame.slice(0, 200))
}
{
  const body = h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: taskNotice('Background command "the build" completed (exit code 0)'), commandMode: 'task-notification' }, addMargin: false, verbose: false })
  const held = await paint(body, { type: 'attachment', timestamp: STAMP, queued: true })
  check('RED on the base: a held task completion names the same arrival clock', held.includes(`held since ${clockOf(STAMP)} ● Background command`), held)
  const taken = await paint(body, { type: 'attachment', timestamp: STAMP })
  check('a taken task completion keeps its delivered clock with no held plate', taken.includes(`${clockOf(STAMP)} ● Background command`) && !taken.includes('held') && !taken.includes('queued'), taken)
  const compacting = await paint(body, { type: 'attachment', timestamp: STAMP, queued: true, heldFor: 'compaction' })
  check('the compaction plate stays unchanged', compacting.includes('held ● Background command') && !compacting.includes('since'), compacting)
}
{
  const frame = await paint(h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: 'Stop hook blocking error from command "lint": 3 errors', commandMode: 'task-notification' }, addMargin: false, verbose: false }), { type: 'attachment', timestamp: STAMP })
  check('free text drained on the notification lane paints as a plain notice', frame.includes('● notice') && frame.includes('Stop hook blocking error from command "lint": 3 errors') && !frame.includes('❯'), frame.slice(0, 200))
}
{
  const frame = await paint(h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text: 'carried to the owner, waiting' }, verbose: false }), { type: 'user', timestamp: STAMP })
  check("the operator's own line keeps its caret and handle", frame.includes('[sam]') && frame.includes('❯ carried to the owner, waiting'), frame.slice(0, 160))
  check('…and wears no notice plate', !frame.includes('● notice') && !frame.includes('● monitor'), frame.slice(0, 160))
}
{
  const frame = await paint(h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text: '<p>hello there' }, verbose: false }), { type: 'user', timestamp: STAMP })
  check('a line that only starts with a tag keeps the caret', frame.includes('❯ <p>hello there'), frame.slice(0, 160))
}
{
  const frame = await paint(h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: taskNotice('Agent "the errand" completed'), commandMode: 'task-notification' }, addMargin: false, verbose: false }), { type: 'attachment', timestamp: STAMP })
  check('a task notification keeps its own row: the dot and the summary, no notice plate', frame.includes('● Agent "the errand" completed') && !frame.includes('● notice'), frame.slice(0, 160))
}
{
  const frame = await paint(h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: 'a queued line of yours', commandMode: 'prompt' }, addMargin: false, verbose: false }), { type: 'attachment', timestamp: STAMP, queued: true })
  check("a queued line of the operator's keeps the caret", frame.includes('❯ a queued line of yours') && !frame.includes('● notice'), frame.slice(0, 160))
}

console.log(`\nprove-notice-row-paint: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
