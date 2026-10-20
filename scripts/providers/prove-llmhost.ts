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
  const { Box } = await import(`${f.root}/src/ink.js`)
  const { AppStateProvider } = await import(`${f.root}/src/state/AppState.tsx`)
  const { ThemeProvider } = await import(`${f.root}/src/components/design-system/ThemeProvider.tsx`)
  const { SettingsPopupSlot } = await import(`${f.root}/src/components/SettingsPopupSlot.tsx`)
  const popup = await import(`${f.root}/src/utils/cockpit/settingsPopup.ts`)
  const command = await registration.default.load()
  await command.call()
  assert.equal(popup.settingsPopupRequest().view, 'llmhost')
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  const m = mounted
  const until = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 10_000), `screen reaches ${text}\n${m.screen()}`)
  const capture = (name: string) => {
    const at = process.argv.indexOf('--frames')
    const dir = at >= 0 ? process.argv[at + 1] : undefined
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}.txt`), m.screen()) }
    assert.ok(!m.screen().includes('RENDER ERROR'))
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
  await until('Detected sglang')
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
  const { getContextWindowForModel } = await import(`${f.root}/src/utils/model/capabilities.ts`)
  const { namedCompatModelOptions } = await import(`${f.root}/src/services/providers/openaicompat/compatCatalogue.ts`)
  const { loginFamilyRows } = await import(`${f.root}/src/components/loginFamilyRows.ts`)
  const { resolveCompatApiKey } = await import(`${f.root}/src/services/providers/openaicompat/compatAccounts.ts`)
  const { SettingsSchema } = await import(`${f.root}/src/utils/settings/types.ts`)
  const settingsRaw = readFileSync(join(f.home, 'settings.json'), 'utf8')
  const settings = JSON.parse(settingsRaw)
  assert.ok(SettingsSchema().safeParse(settings).success)
  assert.equal(settings.compatProvider.llmhost.dialect, 'sglang')
  assert.equal(settings.compatProvider.llmhost.sessionAffinityHeader, 'x-session-id')
  assert.ok(!settingsRaw.includes(f.key))
  assert.equal(resolveCompatApiKey(process.env, 'llmhost').key, f.key)
  assert.equal(getContextWindowForModel(id), 1_048_576)
  assert.ok(namedCompatModelOptions().some((row: any) => row.value === id))
  assert.ok(loginFamilyRows({ engineLegs: true }).some((row: any) => row.value === 'compat/llmhost'))
  f.state.mode = 'tools'
  const messages: any[] = [f.createUserMessage({ content: 'two fixture tool turns' })]
  for (let n = 0; n < 3; n++) {
    const replies = await f.run(id, messages)
    assert.ok(replies.every(row => !row.isApiErrorMessage))
    const body = f.captures.at(-1)!.body
    assert.equal(body.chat_template_kwargs.clear_thinking, false)
    assert.equal(body.reasoning_effort, 'max')
    assert.ok(f.captures.at(-1)!.affinity)
    for (let prior = 0; prior < n; prior++) {
      assert.ok(body.messages.some((row: any) => row.reasoning_content?.includes(`reasoning-${prior}`)))
      assert.ok(body.messages.some((row: any) => row.tool_call_id === `fixture-call-${prior}`))
    }
    messages.push(...replies)
    if (n < 2) messages.push(f.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `fixture-call-${n}`, content: 'done' }] }))
  }
  f.state.mode = 'reply'
  m.push(KEY.esc)
  assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000))
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
  assert.ok(m.screen().includes('check a reply again') && m.screen().includes('change the address') && m.screen().includes('remove this provider'))
  m.push(KEY.esc)
  console.log('LLMHOST GREEN — real popup rows, masked key storage, 1M catalogue, logins, reply timing and two SGLang tool turns; loopback only')
} finally { mounted?.unmount(); f.close() }
