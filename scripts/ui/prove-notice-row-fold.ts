#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '../..')
const WATCH = 'the forty-line watch'
const BODY = Array.from({ length: 40 }, (_, i) => `watch-line-${String(i + 1).padStart(2, '0')}`).join('\n')
const NOTE = `<monitor task="watch" name="${WATCH}">\n${BODY}\n</monitor>`
const task = (summary: string, result: string) => `<task-notification>\n<task-id>fixture</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n<result>${result}</result>\n</task-notification>`
const BACKGROUND = task('Background command "the check" completed (exit code 0)', 'check-one\ncheck-two\ncheck-three')
const CREW = task('Agent "the reviewer" completed', 'review-one\nreview-two\nreview-three')

if (process.argv.includes('--child')) {
  const React = (await import('react')).default
  const { Box, Text, render, useInput } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { AttachmentMessage } = await import('../../src/components/messages/AttachmentMessage.tsx')
  const { MessageMetaProvider } = await import('../../src/components/messages/TranscriptNameplate.tsx')
  const { useMessageActions } = await import('../../src/components/messageActions.tsx')
  const { setMessageCursor, useMessageCursor } = await import('../../src/components/messageCursorStore.ts')
  const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
  const { enqueuePendingNotification, getCommandQueue, remove } = await import('../../src/utils/messageQueueManager.ts')
  const { getQueuedCommandAttachments } = await import('../../src/utils/attachments/queuedCommands.ts')
  type Message = import('../../src/types/message.ts').Message
  type Guts = { rawRecords: Message[]; sends: Array<{ text: string }>; reconcileQueuedSends(facts: unknown): void; paint(): void }
  const connector = new DaemonSessionConnector({ sessionId: 'notice-fold-proof', home: process.env.MERCURY_CONFIG_DIR!, workspaceId: ROOT, title: 'proof', projectLabel: 'proof' } as never)
  const guts = connector as unknown as Guts
  const facts = (queue: unknown[]) => ({ queue, queueReady: true, atMs: Date.now(), busy: true })
  enqueuePendingNotification({ value: NOTE, mode: 'task-notification', priority: 'next' })
  guts.reconcileQueuedSends(facts(getCommandQueue()))
  const h = React.createElement
  function Fixture() {
    const [stage, stageSet] = React.useState('waiting')
    const [full, fullSet] = React.useState(false)
    const cursor = useMessageCursor()
    const selected = connector.records().find(row => row.type === 'attachment')
    const nav = React.useRef({ getSelected: () => selected, enter() {}, prev() {}, next() {}, prevUser() {}, nextUser() {}, top() {}, bottom() {} })
    const actions = useMessageActions(nav as never, { copy() {}, async edit() {} })
    useInput((input, key) => {
      if (input === 'd') {
        void (async () => {
          const commands = getCommandQueue()
          const attachments = await getQueuedCommandAttachments(commands)
          if (attachments.length !== 1 || (attachments[0] as { prompt?: unknown }).prompt !== NOTE) throw new Error('model payload changed')
          remove(commands)
          guts.reconcileQueuedSends(facts([]))
          stageSet('delivered')
        })()
      } else if (input === 't') {
        guts.rawRecords = [...guts.rawRecords, createUserMessage({ content: 'typed after delivery' })]
        guts.paint()
        const row = connector.records().find(row => row.type === 'attachment')
        if (row) setMessageCursor({ uuid: row.uuid, type: 'attachment', expanded: false })
        stageSet('later')
      } else if (key.return) {
        actions.handlers['messageActions:enter']!()
      } else if (input === 'o') {
        fullSet(true)
        stageSet('full')
      }
    })
    const rows = connector.records()
    return h(Box, { flexDirection: 'column' },
      h(Text, null, `stage ${stage} waiting ${guts.sends.filter(s => s.text === NOTE).length}`),
      ...rows.map(row => row.type === 'attachment'
        ? h(MessageMetaProvider, { key: row.uuid, message: row }, h(AttachmentMessage, { attachment: row.attachment, addMargin: false, verbose: cursor?.uuid === row.uuid && cursor.expanded, isTranscriptMode: full }))
        : h(Text, { key: row.uuid }, 'typed after delivery')),
      ...[BACKGROUND, CREW].map((prompt, i) => h(MessageMetaProvider, { key: `task-${i}`, message: { type: 'attachment', timestamp: new Date().toISOString() } }, h(AttachmentMessage, { attachment: { type: 'queued_command', prompt, commandMode: 'task-notification' }, addMargin: false, verbose: full, isTranscriptMode: full }))),
      h(Text, null, 'fixture ready'))
  }
  await render(h(AppStateProvider, { initialState: getDefaultAppState() }, h(Fixture)), { exitOnCtrlC: true, patchConsole: false })
} else {
  let failures = 0
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) failures++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${detail}`}`)
  }
  const noticeModule = await import('../../src/utils/messages/noticeRows.ts')
  const hasNoticeFold = (row: Parameters<typeof noticeModule.hasNoticeFold>[0]): boolean => typeof noticeModule.hasNoticeFold === 'function' && noticeModule.hasNoticeFold(row)
  const taskNoticeBlock = (text: string) => typeof noticeModule.taskNoticeBlock === 'function' ? noticeModule.taskNoticeBlock(text) : null
  const { wrappedNoticeBlocks } = noticeModule
  const { isNavigableMessage, MESSAGE_ACTIONS } = await import('../../src/components/messageActions.tsx')
  const older = { type: 'user', uuid: 'older-notice', message: { content: [{ type: 'text', text: NOTE }] } }
  check('between-turn user notices join the existing row-selection road', hasNoticeFold(older) && isNavigableMessage(older as never))
  const cursor = { uuid: 'older-notice', type: 'user' as const, expanded: false, notice: true as const }
  const enter = MESSAGE_ACTIONS.filter(action => action.key === 'enter' && action.types.includes(cursor.type) && (action.isApplicable?.(cursor) ?? true))
  check('Enter expands a notice rather than editing it as operator text', enter.length === 1 && enter[0]!.staysInCursorMode && enter[0]!.label(cursor) === 'expand')
  check('an empty watch has no armed disclosure', !hasNoticeFold({ ...older, message: { content: [{ type: 'text', text: `<monitor task="empty" name="empty">\n</monitor>` }] } }))
  check('a reminder outside the task lane has no inert disclosure', !hasNoticeFold({ ...older, message: { content: [{ type: 'text', text: '<system-reminder>unchanged reminder</system-reminder>' }] } }))
  check('scheduled wake rows use the same disclosure road', hasNoticeFold({ ...older, origin: { kind: 'saturn', fire: 'wake', firedAt: '2026-10-08T03:00:00Z' }, message: { content: [{ type: 'text', text: 'wake prompt' }] } }))
  check('crewmate messages retain all their message lines behind the fold', taskNoticeBlock(CREW.replace('<result>', '<message>').replace('</result>', '</message>'))?.lines.length === 3)
  const held = NOTE.replace(BODY, `[2 lines arrived while the usage window was closed]\n${BODY}\n[+2 more lines from this watch not listed]`)
  check('held-lines headers and mailbox tails are counted inside the fold', wrappedNoticeBlocks(held)?.[0]?.lines.length === 42)
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') throw new Error(`PTY unavailable: ${driver.kind}`)
  const scratch = mkdtempSync(join(tmpdir(), 'notice-fold-'))
  const home = join(scratch, 'home')
  mkdirSync(home)
  const output = join(scratch, 'grid.json')
  const cfg = join(scratch, 'capture.json')
  writeFileSync(cfg, JSON.stringify({ argv: [process.execPath, import.meta.path, '--child'], cwd: ROOT, cols: 120, rows: 60, total: 160, out: output, sends: [
    { atTick: 100, awaitText: 'fixture ready', requireAwait: true, awaitStableTicks: 2, data: 'd', mark: 'waiting' },
    { afterPrevTicks: 2, awaitText: 'stage delivered', requireAwait: true, awaitStableTicks: 2, data: 't', mark: 'delivered' },
    { afterPrevTicks: 2, awaitText: 'stage later', requireAwait: true, awaitStableTicks: 2, data: '\r', mark: 'folded' },
    { afterPrevTicks: 4, awaitText: 'watch-line-40', requireAwait: true, awaitStableTicks: 2, data: '\r', mark: 'expanded' },
    { afterPrevTicks: 4, awaitText: '40 lines ›', requireAwait: true, awaitStableTicks: 2, data: 'o', mark: 'collapsed' },
    { afterPrevTicks: 4, awaitText: 'stage full', requireAwait: true, awaitStableTicks: 2, data: '', mark: 'full' },
  ] }))
  const cap = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfg], { encoding: 'utf8', timeout: vshotBudgetMs(90_000), env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_OPERATOR: 'sam' } })
  check('the source-rendered PTY journey finished', cap.status === 0, cap.stderr.slice(-800))
  if (cap.status === 0) {
    const payload = JSON.parse(readFileSync(output, 'utf8')) as { marks: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
    const frames = Object.fromEntries(payload.marks.map(mark => [mark.label, mark.grid.map(row => row.map(cell => cell.c).join('').trimEnd()).join('\n')]))
    const folded = frames.folded ?? ''
    const expanded = frames.expanded ?? ''
    check('a delivered notice leaves the waiting sends immediately', (frames.delivered ?? '').includes('stage delivered waiting 0'), frames.delivered?.split('\n')[0])
    check('forty watch lines paint as one counted folded transcript row', folded.includes(`[Monitor] ${WATCH} · 40 lines ›`) && !folded.includes('watch-line-'), folded)
    check('delivery stays above the later typed line', folded.indexOf(`[Monitor]`) >= 0 && folded.indexOf(`[Monitor]`) < folded.indexOf('typed after delivery'), folded)
    check('the transcript Enter road opens every watch line', expanded.includes('40 lines ⌄') && BODY.split('\n').every(line => expanded.includes(line)), expanded)
    check('the same Enter road restores the single line', (frames.collapsed ?? '').includes('40 lines ›') && !(frames.collapsed ?? '').includes('watch-line-'))
    check('background completion has the same fold', folded.includes('[Background] the check · done · 3 lines ›'), folded)
    check('crewmate completion has the same fold', folded.includes('[Crewmate] the reviewer · completed · 3 lines ›'), folded)
    check('full transcript keeps all payload lines', [BODY, 'check-one\ncheck-two\ncheck-three', 'review-one\nreview-two\nreview-three'].every(body => body.split('\n').every(line => (frames.full ?? '').includes(line))))
    const at = process.argv.indexOf('--frames')
    if (at >= 0 && process.argv[at + 1]) {
      mkdirSync(process.argv[at + 1]!, { recursive: true })
      for (const [name, text] of Object.entries(frames)) writeFileSync(join(process.argv[at + 1]!, `${name}.txt`), text + '\n')
      writeFileSync(join(process.argv[at + 1]!, 'grid.json'), readFileSync(output))
    }
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log(`prove-notice-row-fold: ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}
