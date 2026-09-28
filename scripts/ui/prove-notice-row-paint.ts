#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  check('the plate names the kind and the watch', one !== null && noticePlate(one[0]!) === `[Monitor]: ${WATCH}`, one === null ? 'null' : noticePlate(one[0]!))

  const two = noticeOfText(`${monitorBlock('bk1', WATCH, 'event-1')}${monitorBlock('bk1', WATCH, 'event-2')}`, false)
  check('two blocks of the same watch in one text fold into one plate with both lines', two !== null && two.length === 1 && JSON.stringify(two[0]!.lines) === JSON.stringify(['event-1', 'event-2']), JSON.stringify(two))
  const other = noticeOfText(`${monitorBlock('bk1', WATCH, 'event-1')}\n${monitorBlock('bk2', 'the build watch', 'built')}`, false)
  check('two watches in one text keep two plates', other !== null && other.length === 2 && other[1]!.kind === 'monitor' && other[1]!.name === 'the build watch', JSON.stringify(other))
  const empty = noticeOfText(monitorBlock('bk1', '', 'x'), false)
  check('a nameless watch plates as the bare kind word', empty !== null && noticePlate(empty[0]!) === '[Monitor]:')

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

const frameArg = process.argv.indexOf('--frames')
const frameDir = frameArg < 0 ? undefined : process.argv[frameArg + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
async function paint(body: React.ReactElement, meta: { type: string; timestamp?: string; queued?: true; heldFor?: 'compaction' }, band = { columns: 100, rows: 30 }, frameName?: string): Promise<string> {
  let written = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    }),
    { ...band, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(
    h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(MessageMetaProvider as never, { message: meta }, body)),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  if (frameDir !== undefined && frameName !== undefined) writeFileSync(join(frameDir, `${frameName}-${band.columns}x${band.rows}.txt`), strip(instance.lastFrame()) + '\n')
  instance.unmount?.()
  await settle(50)
  return strip(written).replace(/\s+/g, ' ')
}

{
  const text = monitorBlock('bk1', WATCH, '\n==> OPUS-55.md <==\n\n18:26 · OPUS-55 · landed\n')
  const frame = await paint(h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text }, verbose: false }), { type: 'user', timestamp: STAMP })
  check('THE DEFECT PIN: a monitor notice taken between turns paints no operator caret', !frame.includes('❯'), frame.slice(0, 200))
  check('…and no raw wrapper', !frame.includes('<monitor') && !frame.includes('</monitor>'), frame.slice(0, 200))
  check('…the plate names the watch, muted, with no accent dot', frame.includes(`[Monitor]: ${WATCH}`) && !frame.includes('●'), frame.slice(0, 200))
  check('…the event lines stand beneath it', frame.includes('==> OPUS-55.md <==') && frame.includes('18:26 · OPUS-55 · landed'), frame.slice(0, 240))
  check("…under the row's own clock", frame.includes(`${clockOf(STAMP)} [Monitor]:`), frame.slice(0, 120))
  check("…and the operator's handle is nowhere on it", !frame.includes('[sam]'), frame.slice(0, 120))
}
{
  const text = monitorBlock('bk1', WATCH, 'event-1')
  const frame = await paint(h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification' }, addMargin: false, verbose: false }), { type: 'attachment', timestamp: STAMP, queued: true })
  check('RED on the base: a queued notice says held since its arrival, not a delivered clock', frame.includes(`held since ${clockOf(STAMP)} [Monitor]: ${WATCH}`) && !frame.includes('queued') && frame.includes('event-1'), frame.slice(0, 240))
  check('…and never the caret or the wrapper', !frame.includes('❯') && !frame.includes('<monitor'), frame.slice(0, 200))
}
{
  const body = h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: taskNotice('Background command "the build" completed (exit code 0)'), commandMode: 'task-notification' }, addMargin: false, verbose: false })
  const held = await paint(body, { type: 'attachment', timestamp: STAMP, queued: true })
  check('RED on the base: a held task completion names the same arrival clock', held.includes(`held since ${clockOf(STAMP)} ● Background command`), held)
  const taken = await paint(body, { type: 'attachment', timestamp: STAMP })
  check('a taken task completion keeps its own clock with no held plate', taken.includes(`${clockOf(STAMP)} ● Background command`) && !taken.includes('held') && !taken.includes('queued'), taken)
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
  check('…and wears no notice plate', !frame.includes('● notice') && !frame.includes('[Monitor]:'), frame.slice(0, 160))
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

section('§3 the advisor row: the [advisor] plate with the model and the cadence, no dot, dim lines, never the caret (red on the base: the operator\'s line)')
{
  const { advisorBlockOf, advisorPromptLines, isAdvisorOrigin, isMutedNoticeBlock, ADVISOR_PLATE_NAME } = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
  const { wrapCommandText, ADVISOR_NOTE_HEAD, ADVISOR_NOTE_TAIL } = await import(join(ROOT, 'src/utils/messages/text.ts'))
  const origin = { kind: 'advisor', model: 'claude-opus-4-8', seats: 10, at: STAMP }
  const note = 'Verify the pin on the base before you cut.\nThe seam is print.ts, not the driver.'
  check('the guard admits the origin; the block is muted; the plate is the lowercase word', isAdvisorOrigin(origin) && isMutedNoticeBlock(advisorBlockOf(origin as never, note)) && ADVISOR_PLATE_NAME === 'advisor')
  check('the plate reads [advisor] · <model> · every <seats> turns', noticePlate(advisorBlockOf(origin as never, note)) === '[advisor] · claude-opus-4-8 · every 10 turns', noticePlate(advisorBlockOf(origin as never, note)))
  const wrapped = wrapCommandText(note, origin as never)
  check('the mid-turn framing wraps the note in the advisor head and tail, never the operator words', wrapped.startsWith(ADVISOR_NOTE_HEAD) && wrapped.endsWith(ADVISOR_NOTE_TAIL) && !wrapped.includes('The operator sent a new message'), wrapped.slice(0, 120))
  check('the painted lines drop the framing and keep the note', JSON.stringify(advisorPromptLines(wrapped)) === JSON.stringify(note.split('\n')), JSON.stringify(advisorPromptLines(wrapped)))
  const frame = await paint(h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text: note }, verbose: false, origin }), { type: 'user', timestamp: STAMP })
  check('the row paints the clock, then the plate, no accent dot', frame.includes(`${clockOf(STAMP)} [advisor] · claude-opus-4-8 · every 10 turns`) && !frame.includes('●'), frame.slice(0, 200))
  check("…the note's lines beneath, and no caret or handle", frame.includes('Verify the pin on the base before you cut.') && frame.includes('The seam is print.ts, not the driver.') && !frame.includes('❯') && !frame.includes('[sam]'), frame.slice(0, 240))
  const drained = await paint(h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text: wrapped }, verbose: false, origin }), { type: 'user', timestamp: STAMP })
  check('a drained (wrapped) note paints the same plate and the note alone', drained.includes('[advisor] · claude-opus-4-8') && drained.includes('Verify the pin on the base before you cut.') && !drained.includes('A note from your advisor'), drained.slice(0, 240))
}

section('the delivery clock: a notice sits at its completion and names a delivery a minute or more later as a suffix, never in its stamp')
const sixMinutesLater = new Date(Date.parse(STAMP) + 6 * 60_000).toISOString()
const sixMinutesEarlier = new Date(Date.parse(STAMP) - 6 * 60_000).toISOString()
const noticeCases = [
  taskNotice('Background command "the build" completed (exit code 0)'),
  taskNotice('Agent "the errand" completed'),
  taskNotice('Agent "the errand" was stopped').replace('<status>completed</status>', '<status>killed</status>'),
  monitorBlock('watch', 'the build watch', 'the build finished'),
  'the saved work is ready',
  'runner restarted after a crash: 1 background agents relaunched, 1 delivered from their receipts, 0 stopped',
]
for (const prompt of noticeCases) {
  const body = (deliveredAt?: string, sentAt: string = STAMP) => h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt, commandMode: 'task-notification', sentAt, ...(deliveredAt === undefined ? {} : { deliveredAt }) }, addMargin: false, verbose: false })
  const before = await paint(body(), { type: 'attachment', timestamp: STAMP })
  const delayed = await paint(body(sixMinutesLater), { type: 'attachment', timestamp: STAMP })
  check('RED on the base: a notice delivered six minutes after it completed names the delivery as a suffix', delayed.includes(`· delivered ${clockOf(sixMinutesLater)}`), delayed)
  const mark = prompt.startsWith('<monitor') ? '[Monitor]:' : '●'
  check('the row clock remains the completion it sits at, never the delivery', delayed.includes(`${clockOf(STAMP)} ${mark}`) && !delayed.includes('held') && !delayed.includes('· completed'), delayed)
  const nearby = await paint(body(new Date(Date.parse(STAMP) + 2000).toISOString()), { type: 'attachment', timestamp: STAMP })
  check('a two-second delivery paints byte-identically to the ordinary notice', nearby === before, nearby)
  const boundary = await paint(body(new Date(Date.parse(STAMP) + 60_000).toISOString()), { type: 'attachment', timestamp: STAMP })
  check('the second clock starts at exactly one minute', boundary.includes('· delivered'), boundary)
  for (const deliveredAt of ['not a clock', sixMinutesEarlier]) {
    const invalid = await paint(body(deliveredAt), { type: 'attachment', timestamp: STAMP })
    check('an invalid delivery clock, or one before the completion, never invents a suffix', invalid === before, invalid)
  }
  const legacy = await paint(body(undefined, sixMinutesEarlier), { type: 'attachment', timestamp: STAMP })
  check('an older record without a delivery clock paints its own stamp alone (red on the base: a completed suffix)', legacy === before, legacy)
  const held = await paint(body(sixMinutesLater), { type: 'attachment', timestamp: STAMP, queued: true })
  check('a waiting notice names its arrival only, never a delivery suffix', held.includes(`held since ${clockOf(STAMP)}`) && !held.includes('· delivered'), held)
}

section('monitor bodies are muted text even when they carry other row markup')
const monitorBodies = [
  ['command', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fable</command-args>'],
  ['caveat', '<local-command-caveat>keep these words</local-command-caveat>'],
  ['tick', '<tick>keep this tick text</tick>'],
  ['bash', '<bash-input>printf checked</bash-input>'],
  ['task', taskNotice('keep this task text')],
  ['stdout', '<local-command-stdout>keep output</local-command-stdout>'],
  ['memory', '<user-memory-input>keep this memory text</user-memory-input>'],
  ['channel', '<channel source="local">keep this channel text</channel>'],
] as const
const { isMutedNoticeBlock } = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
for (const band of [{ columns: 178, rows: 51 }, { columns: 80, rows: 21 }, { columns: 120, rows: 40 }]) {
  for (const [name, content] of monitorBodies) {
    const text = monitorBlock('watch', 'the transcript watch', content)
    const blocks = wrappedNoticeBlocks(text)
    check(`${name}: a monitor is a muted notice`, blocks !== null && blocks.length === 1 && isMutedNoticeBlock(blocks[0]!))
    for (const queued of [false, true]) {
      const body = queued
        ? h(AttachmentMessage as never, { attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification' }, addMargin: false, verbose: false })
        : h(UserTextMessage as never, { addMargin: false, param: { type: 'text', text }, verbose: false })
      const frame = await paint(body, { type: queued ? 'attachment' : 'user', timestamp: STAMP, ...(queued ? { queued: true as const } : {}) }, band, `monitor-${name}-${queued ? 'held' : 'taken'}`)
      check(`${band.columns} ${name} ${queued ? 'held' : 'taken'}: [Monitor]: precedes literal text, never an operator or command row`, frame.includes('[Monitor]: the transcript watch') && !frame.includes('❯') && !frame.includes('[sam]') && !frame.includes('●') && frame.includes(content.split('\n')[0]!), frame)
    }
  }
}

console.log(`\nprove-notice-row-paint: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
