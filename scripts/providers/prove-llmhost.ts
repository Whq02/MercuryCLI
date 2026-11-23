import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from './lib/llmhostFixture.ts'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const f = await llmhostFixture()
let mounted: Mounted | undefined
try {
  assert.ok(existsSync(join(f.root, 'src/commands/llmhost/index.ts')), '/llmhost has its own popup command')
  f.state.dialect = 'sglang'
  f.state.auth = true
  const registration = await import(`${f.root}/src/commands/llmhost/index.ts`)
  assert.equal(registration.default.seat, 'screen')
  assert.equal(registration.default.userPrivate, true)
  assert.equal(registration.default.supportsNonInteractive, false)
  const React = await import('react')
  const { Box } = await import(`${f.root}/src/screen/themedRenderer.js`)
  const { AppStateProvider } = await import(`${f.root}/src/screen/app-state/AppState.tsx`)
  const { ThemeProvider } = await import(`${f.root}/src/screen/theme/ThemeProvider.tsx`)
  const { SettingsPopupSlot } = await import(`${f.root}/src/screen/overlays/SettingsPopupSlot.tsx`)
  const popup = await import(`${f.root}/src/screen/cockpit/settingsPopup.ts`)
  const command = await registration.default.load()
  await command.call()
  assert.equal(popup.settingsPopupRequest().view, 'llmhost')
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  const m = mounted
  const untilPlain = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 10_000), `screen reaches ${text}\n${m.screen()}`)
  const choose = async (text: string) => {
    for (let n = 0; n < 40; n++) {
      const selected = m.lines().find(line => line.includes('› ')) ?? ''
      if (selected.includes(text)) { m.push(KEY.enter); return }
      m.push(KEY.down)
      assert.ok(await waitFor(() => (m.lines().find(line => line.includes('› ')) ?? '') !== selected, 3000), `selection moves toward ${text}\n${m.screen()}`)
    }
    throw new Error('choice absent: ' + text)
  }
  const until = async (text: string) => {
    if (text.startsWith('Where should the model run')) { await untilPlain('Which model?'); await choose('More options →') }
    await untilPlain(text)
  }
  const capture = (name: string) => {
    const at = process.argv.indexOf('--frames')
    const dir = at >= 0 ? process.argv[at + 1] : undefined
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}.txt`), m.screen()) }
    assert.ok(!m.screen().includes('RENDER ERROR'), `src/commands/llmhost/LlmHostDialog.tsx painted RENDER ERROR at step ${name}`)
    assert.ok(!m.screen().includes(f.key), 'the typed key never paints')
  }
  const first = async (label: string) => { m.push(KEY.down); await until(`› ${label}`); m.push(KEY.enter) }
  await until('Where should the model run?')
  m.push(KEY.down); m.push(KEY.down); m.push(KEY.down)
  await until('› A server that’s already running'); m.push(KEY.enter)
  await until('1 · the server address')
  capture('address')
  m.push(f.baseUrl)
  await until(f.baseUrl)
  m.push(KEY.enter)
  await until('3 · the server key')
  m.push(f.key)
  await until('********')
  capture('masked-key')
  m.push(KEY.enter)
  await until('2 · the server dialect')
  await until('sglang')
  capture('dialect')
  await first('SGLang')
  await until('5 · name the provider')
  await until('1,048,576 tokens')
  assert.ok(m.screen().includes(f.model), 'the single model is named without another question')
  capture('single-model-selected')
  m.push(KEY.enter)
  await until('5 · register and check a reply')
  capture('confirm')
  await first('register and check')
  await until('LLMHOST-READY')
  await until('tokens/s')
  capture('ready')
  const id = `compat/llmhost/${f.model}`
  const { getContextWindowForModel } = await import(`${f.root}/src/models/facts/capabilities.ts`)
  const { namedCompatModelOptions } = await import(`${f.root}/src/models/roads/openaicompat/compatCatalogue.ts`)
  const { loginFamilyRows } = await import(`${f.root}/src/models/sign-in/flow-cards/loginFamilyRows.ts`)
  const { resolveCompatApiKey } = await import(`${f.root}/src/models/roads/openaicompat/compatAccounts.ts`)
  const { SettingsSchema } = await import(`${f.root}/src/platform/settings/settingsSchema.ts`)
  const settingsRaw = readFileSync(join(f.home, 'settings.json'), 'utf8')
  const settings = JSON.parse(settingsRaw)
  assert.ok(SettingsSchema().safeParse(settings).success, 'src/platform/settings/settingsSchema.ts SettingsSchema rejected saved llmhost settings.json')
  assert.equal(settings.compatProvider.llmhost.dialect, 'sglang')
  assert.equal(settings.compatProvider.llmhost.sessionAffinityHeader, 'x-session-id')
  assert.ok(!settingsRaw.includes(f.key), 'src/models/llm-host/index.ts saved settings.json leaked server API key')
  assert.equal(resolveCompatApiKey(process.env, 'llmhost').key, f.key)
  assert.equal(getContextWindowForModel(id), 1_048_576)
  assert.ok(namedCompatModelOptions().some((row: any) => row.value === id), `src/models/roads/openaicompat/compatCatalogue.ts missing registered model ${id}`)
  assert.ok(loginFamilyRows({ engineLegs: true }).some((row: any) => row.value === 'compat/llmhost'), 'src/models/sign-in/flow-cards/loginFamilyRows.ts missing compat/llmhost row')
  f.state.mode = 'tools'
  const messages: any[] = [f.createUserMessage({ content: 'two fixture tool turns' })]
  for (let n = 0; n < 3; n++) {
    const replies = await f.run(id, messages)
    assert.ok(replies.every(row => !row.isApiErrorMessage), `src/models/roads/callModelRouter.ts sglang tool turn ${n} returned API error`)
    const body = f.captures.at(-1)!.body
    assert.equal(body.chat_template_kwargs.clear_thinking, false)
    assert.equal(body.reasoning_effort, 'max')
    assert.ok(f.captures.at(-1)!.affinity, `src/models/roads/openaicompat/compatChatClient.ts sglang turn ${n} missing session affinity header`)
    for (let prior = 0; prior < n; prior++) {
      assert.ok(body.messages.some((row: any) => row.reasoning_content?.includes(`reasoning-${prior}`)), `src/models/roads/openaicompat/compatChatClient.ts sglang turn ${n} dropped reasoning-${prior}`)
      assert.ok(body.messages.some((row: any) => row.tool_call_id === `fixture-call-${prior}`), `src/models/roads/openaicompat/compatChatClient.ts sglang turn ${n} dropped fixture-call-${prior}`)
    }
    messages.push(...replies)
    if (n < 2) messages.push(f.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `fixture-call-${n}`, content: 'done' }] }))
  }
  f.state.mode = 'reply'
  m.push(KEY.esc)
  assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'src/screen/overlays/SettingsPopupSlot.tsx Escape did not close llmhost popup within 5000ms')
  await command.call()
  await until('Where should the model run?')
  m.push(KEY.down); m.push(KEY.down); m.push(KEY.down)
  await until('› A server that’s already running'); m.push(KEY.enter)
  await until('registered servers')
  capture('registered')
  m.push(KEY.down); m.push(KEY.down)
  await until('› llmhost')
  m.push(KEY.enter)
  await until('what to do with this server')
  capture('actions')
  assert.ok(m.screen().includes('check a reply again') && m.screen().includes('change the address') && m.screen().includes('remove this provider'), `src/commands/llmhost/LlmHostDialog.tsx server actions menu missing expected options: ${m.screen().slice(0, 160)}`)
  m.push(KEY.esc)
  console.log('LLMHOST GREEN — real popup rows, masked key storage, 1M catalogue, logins, reply timing and two SGLang tool turns; loopback only')
} finally { mounted?.unmount(); f.close() }
