#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-denial-words-')))
const cwd = join(home, 'project')
const turns: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'denial-probe.txt'), content: 'probe' } },
  { kind: 'text', text: 'Done.' },
  { kind: 'text', text: 'Spare.' },
]
const fixture = await startFixtureApi(turns)
const configDir = join(home, '.mercury')
mkdirSync(cwd, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(join(cwd, 'README.md'), '# fixture\n')
writeFileSync(join(configDir, '.config.json'), JSON.stringify({
  theme: 'dark',
  hasCompletedOnboarding: true,
  customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}))
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_BASE_URL: fixture.url,
  ANTHROPIC_API_KEY: API_KEY,
}

console.log('a host that denies an ask without a message: the model reads the denial in the product\'s own words')
const host = hostRunner({ node: NODE, dist: DIST, argv: ['--model', MODEL], cwd, home, env })
let asksSeen = 0
host.onAsk(() => {
  asksSeen++
  return { outcome: 'deny' }
})
let exit: number | null = null
try {
  await host.initialize()
  await host.prompt('run the probe command')
  await host.waitFor('the turn settles', row => row.type === 'outcome', 90_000)
} catch (error) {
  check('the hosted turn settles', false, String(error))
} finally {
  exit = await host.stop(5_000)
}

const denialTexts: string[] = []
for (const request of fixture.messageRequests()) {
  const body = request.body as { messages?: Array<{ role: string; content: unknown }> }
  for (const message of body.messages ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content as Array<{ type: string; content?: unknown }>) {
      if (block.type !== 'tool_result') continue
      const content = block.content
      denialTexts.push(typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('\n') : JSON.stringify(content))
    }
  }
}
check('the host was asked once', asksSeen === 1, String(asksSeen))
check('the model received a tool_result for the denied call', denialTexts.length >= 1, `exit=${exit} stderr=${host.stderr().slice(0, 200)}`)
check('the denial names the host', denialTexts.some(text => /Permission denied by the host\b/.test(text)), denialTexts.join(' | ').slice(0, 300))
check('…and no SDK', denialTexts.every(text => !/SDK/.test(text)), denialTexts.join(' | ').slice(0, 300))

await fixture.close()
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-host-denial-words: ALL LAWS HOLD' : `\nprove-host-denial-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
