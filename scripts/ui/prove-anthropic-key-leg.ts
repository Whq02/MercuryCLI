import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountsWorld, KEY as API_KEY, WORKSPACE, until } from '../providers/anthropicAccountsFixture.ts'
import { KEY, mountOffscreen, type Mounted } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from './gridToPng.ts'

const world = await accountsWorld()
process.env.FORCE_COLOR = '0'
const React = await import('react')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { ConsoleOAuthFlow } = await import('../../src/components/ConsoleOAuthFlow.tsx')
const { BootLoginsScreen } = await import('../../src/components/BootLoginsScreen.tsx')
const { signedOutFacts } = await import('./face-logins-stills.ts')
let done = 0
let screen: Mounted | undefined
const outAt = process.argv.indexOf('--out')
const output = outAt < 0 ? undefined : process.argv[outAt + 1]
const capture = async (name: string) => {
  if (!output || !screen) return
  mkdirSync(output, { recursive: true })
  const lines = screen.lines()
  const grid = lines.map((line, y) => Array.from(line).map((c, x) => ({ c, ...screen!.styleAt(x, y) })))
  const path = join(output, name)
  writeFileSync(path + '.json', JSON.stringify({ cols: 120, rows: 40, grid }))
  await gridToPng(path + '.json', path + '.png')
}
const push = async (data: string) => { screen!.push(data); await new Promise(done => setTimeout(done, 80)) }
try {
  const card = React.createElement(ConsoleOAuthFlow, { initialFocus: 'anthropic', onDone: () => { done++ }, onCancel() {}, onOpenaiDone() {} })
  screen = await mountOffscreen(React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(KeybindingSetup as never, {}, card))), 120, 40)
  await until(() => screen!.screen().includes('Anthropic —'), 'login catalogue')
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Anthropic API key — usage-based billing'), 'three Anthropic roads')
  await capture('anthropic-roads')
  await push(KEY.down)
  await push(KEY.down)
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Paste your Anthropic API key'), 'key paste field')
  const refused = 'sk-ant-usr-refused'
  await push(refused)
  assert.ok(!screen.screen().includes(refused), 'key is masked')
  await push(KEY.enter)
  await until(() => screen!.screen().includes('invalid x-api-key'), 'inline provider refusal')
  assert.equal(done, 0)
  assert.equal(world.auth.getAnthropicApiKey(), null)
  await capture('anthropic-key-refused')
  await push(KEY.esc)
  await push(KEY.down)
  await push(KEY.down)
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Paste your Anthropic API key'))
  world.requireWorkspace()
  await push(API_KEY)
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Workspace ID:'), 'workspace field')
  assert.ok(!screen.screen().includes(API_KEY))
  await capture('anthropic-workspace')
  await push(WORKSPACE)
  await push(KEY.enter)
  await until(() => done === 1, 'accepted key')
  assert.equal(world.auth.getAnthropicApiKeyWorkspaceId(API_KEY), WORKSPACE)
  screen.unmount()
  await world.auth.removeApiKey()
  screen = await mountOffscreen(React.createElement(BootLoginsScreen, { facts: signedOutFacts(), family: 'anthropic', fullScene: { columns: 120, rows: 40 } }), 120, 40)
  await until(() => screen!.screen().includes('Anthropic —'), 'boot catalogue')
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Anthropic API key'), 'boot arms')
  await push(KEY.down)
  await push(KEY.down)
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Paste your Anthropic API key'), 'boot key field')
  await push(API_KEY)
  assert.ok(!screen.screen().includes(API_KEY))
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Anthropic workspace ID'), 'boot workspace field')
  await capture('anthropic-boot-workspace')
  await push(WORKSPACE)
  await push(KEY.enter)
  await until(() => screen!.screen().includes('Anthropic API key saved.'), 'boot key saved')
  assert.equal(world.auth.getAnthropicApiKeyWorkspaceId(API_KEY), WORKSPACE)
  console.log('PASS chat and Boot Anthropic key fields: masked paste, inline 401, workspace prompt and saved account')
} finally { screen?.unmount(); await world.close() }
