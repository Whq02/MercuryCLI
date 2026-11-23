import React from 'react'
import { mock } from 'bun:test'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('elicitation-field-updates')
let failures = 0
const check = (label: string, ok: boolean, hint = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && hint ? ' — HINT: ' + hint : ''}`)
  if (!ok) failures++
}
const pending: Array<(value: { isValid: boolean; value: string }) => void> = []
await import('../../src/tools/crewmate/CrewmateTool.js')
const validation = await import('../../src/integrations/mcp/elicitationValidation.js')
mock.module('../../src/integrations/mcp/elicitationValidation.js', () => ({
  ...validation,
  validateElicitationInputAsync: async () => new Promise(resolve => { pending.push(resolve) }),
}))
const { ElicitationDialog } = await import('../../src/screen/mcp/ElicitationDialog.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
type Answer = { action: string; content?: Record<string, unknown> }
const h = React.createElement
const open = (schema: Record<string, unknown>, answers: Answer[]) => mountOffscreen(
  h(AppStateProvider, { children: h(ThemeProvider, null, h(KeybindingSetup, null, h(Box, { width: 100, height: 32, flexDirection: 'column' },
    h(ElicitationDialog, {
      event: { serverName: 'fixture', signal: new AbortController().signal, params: { mode: 'form', message: 'fixture form', requestedSchema: schema } } as never,
      onResponse: (action, content) => { answers.push({ action, content }) },
      onWaitingDismiss: () => {},
    }),
  ))) }), 100, 32,
)
const press = async (view: Awaited<ReturnType<typeof open>>, key: string): Promise<void> => { view.push(key); await settle(100) }

try {
  const answers: Answer[] = []
  const date = await open({ type: 'object', properties: { when: { type: 'string', format: 'date' } } }, answers)
  check('the date field paints', await waitFor(() => date.screen().includes('when'), 3000), 'the date form field did not render within 3s; check FormElicitationDialog in src/screen/mcp/ElicitationDialog.tsx and formDialogView in src/screen/mcp/elicitation-dialog/form.tsx')
  await press(date, 'tomorrow')
  await press(date, KEY.down)
  check('leaving natural-language text starts its asynchronous resolution', await waitFor(() => pending.length === 1, 1000), 'commitOnLeave in src/screen/mcp/ElicitationDialog.tsx must call scheduleDateResolve (scheduleDateResolveOf in src/screen/mcp/elicitation-dialog/form.tsx) when the cursor leaves a date field that holds unresolved text')
  await press(date, KEY.up)
  for (let index = 0; index < 'tomorrow'.length; index++) await press(date, '\x7f')
  await press(date, '2030-05-20')
  pending.shift()?.({ isValid: true, value: '2031-01-01' })
  await settle(100)
  await press(date, KEY.down)
  await press(date, KEY.enter)
  check('a late date resolution cannot replace the newer literal date in the payload', answers[0]?.action === 'accept' && answers[0]?.content?.when === '2030-05-20', 'scheduleDateResolveOf in src/screen/mcp/elicitation-dialog/form.tsx must ignore a result that is aborted, or must keep the typed literal when the text changed after the resolve started (typedSinceResolveRef, set by commitTextOf in the same file)')
  date.unmount()
  await settle(100)

  const multiAnswers: Answer[] = []
  const multi = await open({ type: 'object', properties: { colors: { type: 'array', items: { type: 'string', enum: ['red', 'green'] }, minItems: 2 } }, required: ['colors'] }, multiAnswers)
  check('the multiple-choice field paints', await waitFor(() => multi.screen().includes('colors'), 3000), 'the multiple-choice form field did not render within 3s; check FormElicitationDialog in src/screen/mcp/ElicitationDialog.tsx and formDialogView in src/screen/mcp/elicitation-dialog/form.tsx')
  await press(multi, KEY.right)
  await press(multi, ' ')
  await press(multi, KEY.down)
  await press(multi, KEY.enter)
  await press(multi, KEY.enter)
  check('picking the last required choice with enter validates the new selection', multiAnswers[0]?.action === 'accept' && JSON.stringify(multiAnswers[0]?.content?.colors) === '["red","green"]', 'the enter handling in formKeysOf (src/screen/mcp/elicitation-dialog/form.tsx) and multiBoundsError (src/screen/mcp/ElicitationDialog.tsx) must validate the selection including the choice just picked, not the earlier one')
  multi.unmount()
  await settle(100)

  const stringAnswers: Answer[] = []
  const text = await open({ type: 'object', properties: { label: { type: 'string', minLength: 1, default: 'abc' } } }, stringAnswers)
  check('the constrained text field paints', await waitFor(() => text.screen().includes('abc'), 3000), 'the constrained text form field did not render within 3s; check FormElicitationDialog in src/screen/mcp/ElicitationDialog.tsx and formDialogView in src/screen/mcp/elicitation-dialog/form.tsx')
  for (let index = 0; index < 3; index++) await press(text, '\x7f')
  await press(text, KEY.down)
  await press(text, KEY.enter)
  check('clearing an already-set constrained string does not submit an invalid empty value', stringAnswers.length === 0, 'commitTextOf in src/screen/mcp/elicitation-dialog/form.tsx must revalidate an emptied string field that had a value (validateElicitationInput) so the empty text leaves it invalid and submit is refused')
  text.unmount()
} finally {
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
