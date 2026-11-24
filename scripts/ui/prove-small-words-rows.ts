#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'small-words-rows-home-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
let hint = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} · ` : ''}${hint}` : ''}`)
}
const section = (title: string, where: string): void => {
  hint = where
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/screen/themedRenderer.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/screen/app-state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
enableConfigs()
const { taskNoticeBlock } = await import(join(ROOT, 'src/engine/message-shapes/noticeRows.ts'))
const { UserCrewmateNotificationMessage } = await import(join(ROOT, 'src/screen/messages/UserCrewmateNotificationMessage.tsx'))
const { UserNoticeMessage } = await import(join(ROOT, 'src/screen/messages/UserNoticeMessage.tsx'))
const { MessageMetaProvider } = await import(join(ROOT, 'src/screen/messages/TranscriptNameplate.tsx'))
const { KeybindingSetup } = await import(join(ROOT, 'src/screen/keys/KeybindingProviderSetup.tsx'))
const { ComposerHelpMenu } = await import(join(ROOT, 'src/screen/composer/ComposerHelpMenu.tsx'))
const h = React.createElement as (...args: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 120): Promise<void> => new Promise(r => setTimeout(r, ms))
const STAMP = '2026-06-19T12:00:07.000Z'

async function paint(node: React.ReactElement, band = { columns: 120, rows: 30 }): Promise<string> {
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
    h(
      AppStateProvider as never,
      { initialState: getDefaultAppState() },
      h(
        KeybindingSetup as never,
        null,
        h(MessageMetaProvider as never, { message: { type: 'attachment', timestamp: STAMP } }, node),
      ),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  instance.unmount?.()
  await settle(40)
  return strip(written).replace(/\s+/g, ' ').trim()
}

section(
  '§1 background command done row: omit count unless the notice carries the output, other notices keep theirs',
  'change taskNoticeBlock in src/engine/message-shapes/noticeRows.ts and count handling in src/screen/messages/UserNoticeMessage.tsx',
)
{
  const bgNoResult = `<task-notification>
<task-id>bjta8d78f</task-id>
<command>sleep 20 && echo bg-done2</command>
<output-file>/tmp/bjta8d78f.output</output-file>
<status>completed</status>
<summary>Background command "sleep 20 && echo bg-done2" completed (exit code 0)</summary>
</task-notification>`
  const block = taskNoticeBlock(bgNoResult)
  check('a background command without <result> marks its count unknown while keeping its expanded lines', block !== null && block.kind === 'task' && block.count === null && block.lines.length === 3, JSON.stringify(block))

  const folded = await paint(h(UserCrewmateNotificationMessage as never, { param: { type: 'text', text: bgNoResult }, expanded: false }))
  check('its folded done row shows no line count (· done ›, never · 3 lines ›)', folded.includes('● [Background] sleep 20 && echo bg-done2 · done ›') && !/\b\d+ lines?\b/.test(folded), folded)

  const expanded = await paint(h(UserCrewmateNotificationMessage as never, { param: { type: 'text', text: bgNoResult }, expanded: true }))
  check('its expanded done row keeps the details without inventing a count', expanded.includes('● [Background] sleep 20 && echo bg-done2 · done ⌄') && expanded.includes('/tmp/bjta8d78f.output') && !/\b\d+ lines?\b/.test(expanded), expanded)

  const bgWithResult = `<task-notification>
<task-id>bg2</task-id>
<command>echo bg-done2</command>
<output-file>/tmp/bg2.output</output-file>
<status>completed</status>
<summary>Background command "echo bg-done2" completed (exit code 0)</summary>
<result>bg-done2</result>
</task-notification>`
  const withResult = await paint(h(UserCrewmateNotificationMessage as never, { param: { type: 'text', text: bgWithResult }, expanded: false }))
  check('a background command whose notice already carries <result> shows the output line count', withResult.includes('● [Background] echo bg-done2 · done · 1 line ›'), withResult)

  const crewmateNotice = `<task-notification>
<task-id>a1</task-id>
<status>completed</status>
<summary>Agent "the errand" completed</summary>
</task-notification>`
  const crew = await paint(h(UserCrewmateNotificationMessage as never, { param: { type: 'text', text: crewmateNotice }, expanded: false }))
  check('a crewmate notice keeps its count', crew.includes('● [Crewmate] the errand · completed · 1 line ›'), crew)

  const plain = await paint(h(UserNoticeMessage as never, { blocks: [{ kind: 'notice', lines: ['first', 'second'] }], fold: true }))
  check('a plain notice keeps its count', plain.includes('● notice · 2 lines ›'), plain)

  const monitor = await paint(h(UserNoticeMessage as never, { blocks: [{ kind: 'monitor', taskId: 'm1', name: 'watch', lines: ['a', 'b'] }], fold: true }))
  check('a monitor notice keeps its count', monitor.includes('[Monitor] watch · 2 lines ›'), monitor)
}

section(
  '§2 ? shortcuts list: shift + tab cycles the mode',
  'change the mode row text in ComposerHelpMenu in src/screen/composer/ComposerHelpMenu.tsx',
)
{
  const help = await paint(h(ComposerHelpMenu as never, { availableColumns: 120 }), { columns: 120, rows: 30 })
  check('? shortcuts list names "shift + tab to cycle the mode" and never "for implement mode"', help.includes('shift + tab to cycle the mode') && !help.includes('for implement mode'), help)
}

section(
  '§3 ? shortcuts list and composer footer agree on "! for shell mode"',
  'change the ! row text in ComposerHelpMenu in src/screen/composer/ComposerHelpMenu.tsx and the bash-mode hint in src/screen/composer/ComposerFooterLeftSide.tsx',
)
{
  const { ComposerFooterLeftSide } = await import(join(ROOT, 'src/screen/composer/ComposerFooterLeftSide.tsx'))
  const help = await paint(h(ComposerHelpMenu as never, { availableColumns: 120 }), { columns: 120, rows: 30 })
  check('? shortcuts list says "! for shell mode" and never "! for bash mode"', help.includes('! for shell mode') && !help.includes('! for bash mode'), help)
  const footer = await paint(
    h(ComposerFooterLeftSide as never, { exitPending: false, exitKeyName: null, isPasting: false, mode: 'bash', isLoading: false }),
    { columns: 120, rows: 10 },
  )
  check('composer footer hint also says "! for shell mode"', footer.includes('! for shell mode') && !footer.includes('! for bash mode'), footer)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-small-words-rows: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
