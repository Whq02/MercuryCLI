#!/usr/bin/env bun
import { KEY, mountOffscreen, settle, waitFor } from '../lib/settingsPopupHarness.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
for (const key of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'HF_TOKEN', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL',
]) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

;(await import('../../src/platform/settings/config.ts')).enableConfigs()
const React = await import('react')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ModelPicker } = await import('../../src/screen/model-picker/ModelPicker.tsx')
const { getModelOptions, isCatalogueDoorRow, isProviderActionRow } = await import('../../src/models/catalogue/modelOptions.ts')

const wanted = getModelOptions().filter(option => !option.unavailable && !isCatalogueDoorRow(option.value))
const actions = wanted.filter(option => isProviderActionRow(option.value))
const models = wanted.filter(option => !isProviderActionRow(option.value))
check('a home with one provider connected is offered a way to the others', actions.length >= 5 && models.length >= 1, `${actions.length} sign-in or key rows, ${models.length} models`)

const picked: string[] = []
const h = React.createElement
const list = h(ModelPicker as never, { initial: null, onSelect: (model: string) => { picked.push(model) }, onCancel() {}, isStandaloneCommand: true, skipSettingsWrite: true })
const screen = await mountOffscreen(h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(KeybindingSetup as never, {}, list))), 120, 44)
try {
  const first = wanted[0]
  const shown = (text: string): boolean => screen.screen().replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' '))
  check('the list opens', first !== undefined && (await waitFor(() => shown(isProviderActionRow(first.value) ? first.label : first.value), 5_000)), screen.screen().slice(0, 400))
  const seen = new Set<string>()
  const note = (): void => { for (const option of wanted) if (shown(isProviderActionRow(option.value) ? option.label : option.value)) seen.add(option.value) }
  note()
  for (let step = 0; step < wanted.length; step++) {
    screen.push(KEY.down)
    await settle(25)
    note()
  }
  const missingActions = actions.filter(option => !seen.has(option.value)).map(option => option.label)
  const missingModels = models.filter(option => !seen.has(option.value)).map(option => option.value)
  check(`every sign-in and key row the options hold is in the list (${actions.length})`, missingActions.length === 0, `missing: ${missingActions.join(' | ')}`)
  check(`every model the options hold is in the list (${models.length})`, missingModels.length === 0, `missing: ${missingModels.join(' | ')}`)
} finally {
  screen.unmount()
}
const first = actions[0]!
const chosen = await mountOffscreen(h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(KeybindingSetup as never, {}, h(ModelPicker as never, { initial: first.value, onSelect: (model: string) => { picked.push(model) }, onCancel() {}, isStandaloneCommand: true, skipSettingsWrite: true })))), 120, 44)
try {
  await waitFor(() => chosen.screen().replace(/\s+/g, ' ').includes(first.label.replace(/\s+/g, ' ')), 5_000)
  chosen.push(KEY.enter)
  await waitFor(() => picked.length > 0, 3_000)
  check('choosing a sign-in or key row hands that row on, so its sign-in can open', picked.length === 1 && picked[0] === first.value, `picked ${JSON.stringify(picked)}; wanted ${first.value}`)
} finally {
  chosen.unmount()
}
console.log('\n' + (failures === 0 ? 'MODEL LIST CONNECT ROWS GREEN' : `MODEL LIST CONNECT ROWS RED: ${failures} failed`))
process.exit(failures === 0 ? 0 : 1)
