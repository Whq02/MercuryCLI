#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log("the fold runs where the session's model lives: /compact is a session-seat command executed by the runner's own turn context, and no cockpit dialog context ever starts a compaction")

const { commandSeat } = await import('../../src/commands.ts')
const compact = (await import('../../src/commands/compact/index.ts')).default
check('/compact is a session-seat command (the cockpit sends the line to the runner, never runs it on the dialog context)', commandSeat(compact) === 'session', commandSeat(compact))

const turn = read('src/rows/turn.ts')
check("the runner's turn resolves its model from the live seat (userSpecifiedModel, the set-model door's target, else the engine model)", turn.includes('const resolvedModel = this.userSpecifiedModel ?? getEngineModel()') && turn.includes('setModel(model: string): void {\n    this.userSpecifiedModel = model'))
check("the runner's turn context carries the thinking config beside the model", /engineModel: model,\n\s*thinkingConfig,/.test(turn))

const command = read('src/commands/compact/compact.ts')
check("the fold's model is chosen from the context's live engine model", command.includes('foldModelFor(summaryInput, context.options.engineModel, { forced: false })'))

const fold = read('src/services/compact/compact.ts')
check("the summary request rides the context's own thinking config and the session's effort", fold.includes('thinkingConfig: context.options.thinkingConfig,') && fold.includes('effortValue: context.getAppState().effortValue,'))
check('a chosen summary model replaces only the engine model of the context it is handed', fold.includes("return { ...context, options: { ...context.options, engineModel: model } }"))

const dialog = read('src/components/tasks/BackgroundTasksDialog.tsx')
check('the compact-summary dialog discards the dialog context it is handed and calls no model with it', dialog.includes('void toolUseContext') && !/compactConversation|routedCallModel|runForkedAgent|callModel\(/.test(dialog))

{
  const { openDialogsPart } = await import('../ui/chatScenarios.ts')
  const { BackgroundTasksDialog } = await import('../../src/components/tasks/BackgroundTasksDialog.tsx')
  const dialogs = await openDialogsPart('compact-seat-road-dialogs')
  const React = await import('react')
  await dialogs.plant({ focusedInputDialog: 'cost-threshold' })
  await dialogs.plant({ focusedInputDialog: undefined, toolJSX: { jsx: React.createElement(React.Fragment), shouldHidePromptInput: false, isLocalJSXCommand: true } as never, localJsx: true })
  const builtElsewhere = dialogs.contexts.length
  await dialogs.plant({ toolJSX: null, localJsx: false, compactDetailUp: true })
  const modal = dialogs.part.value().centredModal as { type?: unknown; props?: { entry?: string; toolUseContext?: { planted?: string } } } | null
  const built = dialogs.contexts.length
  await dialogs.close()
  check("the cockpit's dialog context reaches the compact-summary view only (no other compaction entry rides it)", builtElsewhere === 0 && built === 1 && modal?.type === BackgroundTasksDialog && modal.props?.entry === 'compact-summary' && modal.props.toolUseContext?.planted === 'context', `contexts built with no compact summary up ${builtElsewhere}, with it ${built} · the modal is the background tasks dialog ${String(modal?.type === BackgroundTasksDialog)} · entry ${String(modal?.props?.entry)}`)
}

console.log(failures === 0 ? '\nprove-compact-seat-road: ALL LAWS HOLD' : `\nprove-compact-seat-road: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
