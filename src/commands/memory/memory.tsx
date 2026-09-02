import * as React from 'react'
import { Suspense, useState } from 'react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { Box, Text } from '../../ink.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { MemoryCentreView } from '../../components/memory/MemoryCentreView.js'
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import {
  clearInstructionFileCaches,
  getInstructionCompositionState,
  getInstructionFiles,
} from '../../services/instructions/engine.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { toRelativePath } from '../../utils/path.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

/** The dimmed status line under the files picker: live profile facts. */
function profileStatusLine(): string {
  const { resolution } = getInstructionCompositionState()
  const profile =
    resolution.requested === resolution.resolved
      ? `instruction profile: ${resolution.resolved}`
      : `instruction profile: ${resolution.requested} → ${resolution.resolved} (${resolution.mapped})`
  return `${profile} · instruction files load every session · memory management lives in the centre`
}

/**
 * Open a memory/instruction file for editing. The reply never claims the
 * file was opened when no editor could be (the honesty rule): it reports
 * what happened and what to do instead.
 */
async function openMemoryFile(path: string, onDone: LocalJSXCommandOnDone): Promise<void> {
  try {
    if (path.includes(getMercuryHome())) {
      mkdirSync(getMercuryHome(), { recursive: true })
    }
    try {
      // Exclusive create: existing content is preserved.
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

function MemoryCommand({
  initialRoute,
  onDone,
}: {
  initialRoute: 'centre' | 'files'
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [route, setRoute] = useState<'centre' | 'files'>(initialRoute)

  if (route === 'centre') {
    return (
      <MemoryCentreView
        onClose={() => onDone(undefined, { display: 'system' })}
        onOpenFiles={() => setRoute('files')}
      />
    )
  }

  const closeFiles = (): void => {
    // Escape returns to the centre UNLESS the files route was entered
    // directly — then it closes outright.
    if (initialRoute === 'files') {
      onDone('Closed memory files', { display: 'system' })
    } else {
      setRoute('centre')
    }
  }

  return (
    <CommandCenter
      view="memory"
      subtitle="instruction & note files"
      footer="open in editor · back"
      captureInput={false}
      onClose={closeFiles}
    >
      <Box flexDirection="column">
        <Suspense>
          <MemoryFileSelector
            onSelect={path => {
              void openMemoryFile(path, onDone)
            }}
            onCancel={closeFiles}
          />
        </Suspense>
        <Text color={tokens.textMuted}>{profileStatusLine()}</Text>
      </Box>
    </CommandCenter>
  )
}

/** `/memory stats` — the MNEME lifecycle numbers as one honest line set:
 *  buffer depth, doc/entry counts, last consolidation, due state, verb
 *  availability, and the validator-refusal count derived from the
 *  maintenance receipts ledger (refusals are never invisible). */
async function statsReply(): Promise<string> {
  const { mnemeStatus, readMaintenanceReceipts } = await import('../../memdir/mnemeMaintenance.js')
  const { memoryVerbsEnabled, memoryVerbsWhyNot } = await import('../../memdir/memoryVerbs.js')
  const status = mnemeStatus()
  if (!status.enabled) {
    return 'MNEME is off (MERCURY_MNEME) — no buffer, no topic docs, no memory verbs.'
  }
  const receipts = readMaintenanceReceipts(undefined, 50)
  const refusals = receipts.filter(r => /refus/i.test(r.reason ?? '')).length
  const verbs = memoryVerbsEnabled()
    ? 'Retain/Recall/Reflect/Correct available'
    : `memory verbs absent — ${memoryVerbsWhyNot() ?? 'unknown'}`
  return [
    `buffer: ${status.buffered} row(s)${status.pendingConsuming > 0 ? ` (+${status.pendingConsuming} mid-consolidation)` : ''}`,
    `library: ${status.topicCount} topic doc(s) · ${status.entryCount} live entr(ies) · ${status.historyCount} history`,
    `last consolidation: ${status.lastConsolidatedAt ?? 'never'} · due now: ${status.due ? `yes (${status.dueReason})` : 'no'}`,
    `validator refusals (last ${receipts.length} maintenance runs): ${refusals}`,
    verbs,
    ...(status.degraded.length > 0 ? [`degraded: ${status.degraded.join(' · ')}`] : []),
  ].join('\n')
}

/** `/memory enqueue` — force a consolidation due-check NOW (the operator
 *  trigger), reporting what actually ran. */
async function enqueueReply(): Promise<string> {
  const { runDueMaintenance } = await import('../../memdir/mnemeMaintenance.js')
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
  // Load BEFORE rendering: the picker sits in a suspense boundary and would
  // only flash its fallback, but opening already populated beats flickering.
  clearInstructionFileCaches()
  await getInstructionFiles()

  const route = trimmed === 'files' ? 'files' : 'centre'
  return <MemoryCommand initialRoute={route} onDone={onDone} />
}
