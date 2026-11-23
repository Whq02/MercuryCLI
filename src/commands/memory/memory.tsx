import * as React from 'react'
import { Suspense, useCallback, useState } from 'react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { Box, Text, wrapText } from '../../screen/themedRenderer.js'
import { MemoryCentreView } from '../../screen/memory/MemoryCentreView.js'
import { MemoryFileSelector } from '../../screen/memory/MemoryFileSelector.js'
import {
  MEMORY_POPUP_ROWS,
  MEMORY_POPUP_TITLE_VIEW,
  MEMORY_POPUP_WIDTH,
  memoryFooter,
  memoryPopupLine,
  plural,
} from '../../screen/memory/memoryCentreLayout.js'
import { useSettingsPopupFrame } from '../../screen/settings/Settings.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { useLayoutClaim, useLayoutPublish } from '../../screen/effects/effects.js'
import { getProjectRoot } from '../../boot/process-state/processState.js'
import { getMnemeHome } from '../../sessions/mneme/paths.js'
import {
  clearInstructionFileCaches,
  getInstructionCompositionState,
  getInstructionFiles,
} from '../../sessions/instructions/instructionFiles.js'
import { instructionsInMessages, type AttachedInstruction } from '../../sessions/instructions/attachedText.js'
import { normalizePathForComparison } from '../../platform/files/file.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { LocalJSXCommandOnDone } from '../catalogue/command.js'
import { openSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../screen/cockpit/settingsPopup.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { logError } from '../../platform/logs/errorLog.js'
import { toRelativePath, toTildePath } from '../../platform/files/path.js'
import { editFileInEditor } from '../../screen/composer/promptEditor.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

export type MemoryRoute = 'centre' | 'files'

export const MEMORY_FILES_CLOSED = 'Closed memory files'

export function profileStatusLine(): string {
  const { resolution } = getInstructionCompositionState()
  return resolution.resolved === 'native'
    ? 'profile native: MERCURY.md only · every file here loads every session'
    : "profile auto: MERCURY.md, or other tools' files when there is none · a row says when its file loads"
}

async function openMemoryFile(path: string, onDone: LocalJSXCommandOnDone): Promise<void> {
  try {
    if (path.includes(getMercuryHome())) {
      mkdirSync(getMercuryHome(), { recursive: true })
    }
    try {
      writeFileSync(path, '', { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }
    const result = await editFileInEditor(path)
    const relative = toRelativePath(path)
    if (result.content === null) {
      if (result.error) {
        onDone(`Could not open ${relative} in an editor: ${result.error}`, { display: 'system' })
        return
      }
      onDone(
        `No editor is configured, so ${relative} was not opened. Set $EDITOR or $VISUAL (for example: export EDITOR=nano) and run /memory files again — or manage Mercury-owned memory in the centre instead.`,
        { display: 'system' },
      )
      return
    }
    const visual = hostEnv().VISUAL
    const editor = hostEnv().EDITOR
    const editorNote = visual
      ? `> $VISUAL is in effect: ${visual}`
      : editor
        ? `> $EDITOR is in effect: ${editor}`
        : '> Set $EDITOR or $VISUAL to choose the editor.'
    onDone(`Opened ${relative}\n${editorNote}`, { display: 'system' })
  } catch (error) {
    logError(error)
    onDone(`Error opening memory file: ${String(error)}`)
  }
}

type Settle = (...args: Parameters<LocalJSXCommandOnDone>) => void

type Held = (path: string) => boolean

function MemoryFilesRoute({ direct, onPick, onCancel, held, attached, width, rowBudget }: { direct: boolean; onPick: (path: string) => void; onCancel: () => void; held: Held; attached?: readonly AttachedInstruction[]; width: number; rowBudget: number }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  const tokens = useMercuryTokens()
  const footer = profileStatusLine()
  const footerRows = wrapText(footer, Math.max(1, width), 'wrap').split('\n').length
  useLayoutPublish(() => {
    frame.setHint(memoryFooter({ kind: 'files', direct }))
  }, [frame, direct])
  return (
    <Box flexDirection="column">
      <Suspense>
        <MemoryFileSelector onSelect={onPick} onCancel={onCancel} held={held} attached={attached} width={width} rowBudget={rowBudget - footerRows} />
      </Suspense>
      <Text color={tokens.textMuted} wrap="wrap">{footer}</Text>
    </Box>
  )
}

export function MemoryPopupBody({
  geometry,
  initialRoute,
  settle,
  held,
  attached,
}: {
  geometry: SettingsPopupGeometry
  initialRoute: MemoryRoute
  settle: Settle
  held: Held
  attached?: readonly AttachedInstruction[]
}): React.ReactNode {
  const frame = useSettingsPopupFrame()
  const [route, setRoute] = useState<MemoryRoute>(initialRoute)
  const [returnRow, setReturnRow] = useState<string | null>(null)
  useLayoutClaim(() => {
    frame.setOwnsEscape(true)
    return () => frame.setOwnsEscape(false)
  }, [frame])
  useLayoutClaim(() => () => settle(undefined, { display: 'skip' }), [settle])
  const close = useCallback(
    (text?: string, options?: Parameters<LocalJSXCommandOnDone>[1]): void => {
      settle(text, options ?? (text === undefined ? { display: 'skip' } : undefined))
      frame.close()
    },
    [settle, frame],
  )
  if (route === 'centre') {
    return (
      <MemoryCentreView
        onClose={() => close()}
        onOpenFiles={() => {
          setReturnRow('files')
          setRoute('files')
        }}
        initialRow={returnRow}
        onOpenFile={path => {
          void openMemoryFile(path, (text, options) => close(text, options))
        }}
        width={geometry.inner}
        rowBudget={geometry.rowBudget}
        onHint={frame.setHint}
      />
    )
  }
  return (
    <MemoryFilesRoute
      width={geometry.inner}
      rowBudget={geometry.rowBudget}
      held={held}
      attached={attached}
      direct={initialRoute === 'files'}
      onPick={path => {
        void openMemoryFile(path, (text, options) => close(text, options))
      }}
      onCancel={() => {
        if (initialRoute === 'files') close(MEMORY_FILES_CLOSED, { display: 'system' })
        else setRoute('centre')
      }}
    />
  )
}

export function memoryPopupLineNow(): string {
  return memoryPopupLine(getProjectRoot(), toTildePath(getMnemeHome()))
}

export function memoryPopupRequest(initialRoute: MemoryRoute, onDone: LocalJSXCommandOnDone, held: Held = () => false, attached?: readonly AttachedInstruction[]): SettingsPopupRequest {
  let settled = false
  const settle: Settle = (text, options) => {
    if (settled) return
    settled = true
    onDone(text, options)
  }
  return {
    view: MEMORY_POPUP_TITLE_VIEW,
    width: hostColumns => Math.min(MEMORY_POPUP_WIDTH, hostColumns),
    rows: MEMORY_POPUP_ROWS,
    line: memoryPopupLineNow(),
    hint: memoryFooter(initialRoute === 'files' ? { kind: 'files', direct: true } : { kind: 'overview', action: null }),
    body: geometry => <MemoryPopupBody geometry={geometry} initialRoute={initialRoute} settle={settle} held={held} attached={attached} />,
  }
}

async function statsReply(): Promise<string> {
  const { join } = await import('node:path')
  const { mnemeStatus, readMaintenanceReceipts } = await import('../../sessions/mneme/mnemeMaintenance.js')
  const { memoryVerbsEnabled, memoryVerbsWhyNot } = await import('../../sessions/mneme/memoryVerbs.js')
  const { mnemeLibraryDir } = await import('../../sessions/mneme/mnemeGates.js')
  const { getMemoryBaseDir, mnemeProjectKey, projectRecordsDir } = await import('../../sessions/mneme/paths.js')
  const { mnemeUnreadSentence } = await import('../../sessions/mneme/mnemeUnread.js')
  const status = mnemeStatus()
  if (!status.enabled) {
    return 'memory is off (memory.enabled is false in settings) — no buffer, no topic pages, no memory verbs.'
  }
  const receipts = readMaintenanceReceipts(undefined, 50)
  const refusals = receipts.filter(r => /refus/i.test(r.reason ?? '')).length
  const verbs = memoryVerbsEnabled()
    ? 'Retain/Recall/Reflect/Correct available'
    : `memory verbs absent — ${memoryVerbsWhyNot() ?? 'unknown'}`
  const unread = mnemeUnreadSentence([mnemeLibraryDir(), projectRecordsDir(mnemeProjectKey())], [join(getMemoryBaseDir(), 'projects')])
  return [
    `buffer: ${plural(status.buffered, 'row')}${status.pendingConsuming > 0 ? ` (+${status.pendingConsuming} mid-consolidation)` : ''}`,
    `library: ${plural(status.topicCount, 'topic page')} · ${plural(status.entryCount, 'live fact')} · ${status.historyCount} in history`,
    `last consolidation: ${status.lastConsolidatedAt ?? 'never'} · due now: ${status.due ? `yes (${status.dueReason})` : 'no'}`,
    `validator refusals (last ${plural(receipts.length, 'maintenance run')}): ${refusals}`,
    verbs,
    ...(status.degraded.length > 0 ? [`degraded: ${status.degraded.join(' · ')}`] : []),
    ...(unread !== null ? [unread] : []),
  ].join('\n')
}

async function enqueueReply(): Promise<string> {
  const { runDueMaintenance } = await import('../../sessions/mneme/mnemeMaintenance.js')
  const outcome = await runDueMaintenance('operator', { force: true })
  if (!outcome.ran) return `maintenance did not run: ${outcome.reason}`
  return `maintenance ran (${outcome.reason}) — consolidated: ${outcome.consolidated ? `yes, ${outcome.entries} entr(ies) into ${outcome.docsTouched} doc(s)` : 'nothing to do'} · ${outcome.wallMs}ms`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: Pick<ToolUseContext, 'readFileState' | 'messages'>,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = args.trim()
  if (trimmed === 'stats') {
    onDone(await statsReply(), { display: 'system' })
    return null
  }
  if (trimmed === 'enqueue') {
    onDone(await enqueueReply(), { display: 'system' })
    return null
  }
  if (trimmed === 'page') {
    const { openMemoryPage } = await import('./memoryPage.js')
    onDone((await openMemoryPage()).line, { display: 'system' })
    return null
  }
  clearInstructionFileCaches()
  await getInstructionFiles()
  const route: MemoryRoute = trimmed === 'files' ? 'files' : 'centre'
  const attached = context.messages === undefined ? undefined : instructionsInMessages(context.messages)
  const paths = new Set(attached?.map(entry => normalizePathForComparison(entry.path)))
  const held = attached === undefined ? (path: string) => context.readFileState.has(path) : (path: string) => paths.has(normalizePathForComparison(path))
  openSettingsPopup(memoryPopupRequest(route, onDone, held, attached))
  return null
}
