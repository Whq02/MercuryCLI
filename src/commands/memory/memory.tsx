import * as React from 'react'
import { Suspense, useCallback, useLayoutEffect, useState } from 'react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { Box, Text } from '../../ink.js'
import { MemoryCentreView } from '../../components/memory/MemoryCentreView.js'
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js'
import {
  MEMORY_POPUP_ROWS,
  MEMORY_POPUP_TITLE_VIEW,
  MEMORY_POPUP_WIDTH,
  memoryFooter,
  memoryPopupLine,
  plural,
} from '../../components/memory/memoryCentreLayout.js'
import { useSettingsPopupFrame } from '../../components/Settings/Settings.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { getMnemeHome } from '../../mneme/paths.js'
import {
  clearInstructionFileCaches,
  getInstructionCompositionState,
  getInstructionFiles,
} from '../../services/instructions/engine.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { openSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { toRelativePath, toTildePath } from '../../utils/path.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

export type MemoryRoute = 'centre' | 'files'

export const MEMORY_FILES_CLOSED = 'Closed memory files'

export function profileStatusLine(): string {
  const { resolution } = getInstructionCompositionState()
  const profile = resolution.resolved === 'native' ? 'profile native: MERCURY.md only' : 'profile auto: MERCURY.md, or AGENTS.md when there is none'
  return `${profile} · every file here loads every session`
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
    const visual = process.env.VISUAL
    const editor = process.env.EDITOR
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

function MemoryFilesRoute({ direct, onPick, onCancel }: { direct: boolean; onPick: (path: string) => void; onCancel: () => void }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  const tokens = useMercuryTokens()
  useLayoutEffect(() => {
    frame.setHint(memoryFooter({ kind: 'files', direct }))
  }, [frame, direct])
  return (
    <Box flexDirection="column">
      <Suspense>
        <MemoryFileSelector onSelect={onPick} onCancel={onCancel} />
      </Suspense>
      <Text color={tokens.textMuted} wrap="truncate-end">{profileStatusLine()}</Text>
    </Box>
  )
}

export function MemoryPopupBody({
  geometry,
  initialRoute,
  settle,
}: {
  geometry: SettingsPopupGeometry
  initialRoute: MemoryRoute
  settle: Settle
}): React.ReactNode {
  const frame = useSettingsPopupFrame()
  const [route, setRoute] = useState<MemoryRoute>(initialRoute)
  const [returnRow, setReturnRow] = useState<string | null>(null)
  useLayoutEffect(() => {
    frame.setOwnsEscape(true)
    return () => frame.setOwnsEscape(false)
  }, [frame])
  useLayoutEffect(() => () => settle(undefined, { display: 'skip' }), [settle])
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

export function memoryPopupRequest(initialRoute: MemoryRoute, onDone: LocalJSXCommandOnDone): SettingsPopupRequest {
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
    body: geometry => <MemoryPopupBody geometry={geometry} initialRoute={initialRoute} settle={settle} />,
  }
}

async function statsReply(): Promise<string> {
  const { mnemeStatus, readMaintenanceReceipts } = await import('../../mneme/mnemeMaintenance.js')
  const { memoryVerbsEnabled, memoryVerbsWhyNot } = await import('../../mneme/memoryVerbs.js')
  const status = mnemeStatus()
  if (!status.enabled) {
    return 'memory is off (memory.enabled is false in settings) — no buffer, no topic pages, no memory verbs.'
  }
  const receipts = readMaintenanceReceipts(undefined, 50)
  const refusals = receipts.filter(r => /refus/i.test(r.reason ?? '')).length
  const verbs = memoryVerbsEnabled()
    ? 'Retain/Recall/Reflect/Correct available'
    : `memory verbs absent — ${memoryVerbsWhyNot() ?? 'unknown'}`
  return [
    `buffer: ${plural(status.buffered, 'row')}${status.pendingConsuming > 0 ? ` (+${status.pendingConsuming} mid-consolidation)` : ''}`,
    `library: ${plural(status.topicCount, 'topic page')} · ${plural(status.entryCount, 'live fact')} · ${status.historyCount} in history`,
    `last consolidation: ${status.lastConsolidatedAt ?? 'never'} · due now: ${status.due ? `yes (${status.dueReason})` : 'no'}`,
    `validator refusals (last ${plural(receipts.length, 'maintenance run')}): ${refusals}`,
    verbs,
    ...(status.degraded.length > 0 ? [`degraded: ${status.degraded.join(' · ')}`] : []),
  ].join('\n')
}

async function enqueueReply(): Promise<string> {
  const { runDueMaintenance } = await import('../../mneme/mnemeMaintenance.js')
  const outcome = await runDueMaintenance('operator', { force: true })
  if (!outcome.ran) return `maintenance did not run: ${outcome.reason}`
  return `maintenance ran (${outcome.reason}) — consolidated: ${outcome.consolidated ? `yes, ${outcome.entries} entr(ies) into ${outcome.docsTouched} doc(s)` : 'nothing to do'} · ${outcome.wallMs}ms`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
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
  openSettingsPopup(memoryPopupRequest(route, onDone))
  return null
}
