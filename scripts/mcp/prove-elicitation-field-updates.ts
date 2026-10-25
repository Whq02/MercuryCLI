import React from 'react'
import { mock } from 'bun:test'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('elicitation-field-updates')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const pending: Array<(value: { isValid: boolean; value: string }) => void> = []
await import('../../src/tools/AgentTool/AgentTool.js')
const validation = await import('../../src/utils/mcp/elicitationValidation.js')
mock.module('../../src/utils/mcp/elicitationValidation.js', () => ({
  ...validation,
  validateElicitationInputAsync: async () => new Promise(resolve => { pending.push(resolve) }),
}))
const { ElicitationDialog } = await import('../../src/components/mcp/ElicitationDialog.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { Box } = await import('../../src/ink.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
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
  check('the date field paints', await waitFor(() => date.screen().includes('when'), 3000))
  await press(date, 'tomorrow')
  await press(date, KEY.down)
  check('leaving natural-language text starts its asynchronous resolution', await waitFor(() => pending.length === 1, 1000))
  await press(date, KEY.up)
  for (let index = 0; index < 'tomorrow'.length; index++) await press(date, '\x7f')
  await press(date, '2030-05-20')
  pending.shift()?.({ isValid: true, value: '2031-01-01' })
  await settle(100)
  await press(date, KEY.down)
  await press(date, KEY.enter)
  check('a late date resolution cannot replace the newer literal date in the payload', answers[0]?.action === 'accept' && answers[0]?.content?.when === '2030-05-20')
  date.unmount()
  await settle(100)

  const multiAnswers: Answer[] = []
  const multi = await open({ type: 'object', properties: { colors: { type: 'array', items: { type: 'string', enum: ['red', 'green'] }, minItems: 2 } }, required: ['colors'] }, multiAnswers)
  check('the multiple-choice field paints', await waitFor(() => multi.screen().includes('colors'), 3000))
  await press(multi, KEY.right)
  await press(multi, ' ')
  await press(multi, KEY.down)
  await press(multi, KEY.enter)
  await press(multi, KEY.enter)
  check('picking the last required choice with enter validates the new selection', multiAnswers[0]?.action === 'accept' && JSON.stringify(multiAnswers[0]?.content?.colors) === '["red","green"]')
  multi.unmount()
  await settle(100)

  const stringAnswers: Answer[] = []
  const text = await open({ type: 'object', properties: { label: { type: 'string', minLength: 1, default: 'abc' } } }, stringAnswers)
  check('the constrained text field paints', await waitFor(() => text.screen().includes('abc'), 3000))
  for (let index = 0; index < 3; index++) await press(text, '\x7f')
  await press(text, KEY.down)
  await press(text, KEY.enter)
  check('clearing an already-set constrained string does not submit an invalid empty value', stringAnswers.length === 0)
  text.unmount()
} finally {
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
