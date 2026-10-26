import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { accountsWorld, KEY, MODEL, SUBSCRIPTION } from '../providers/anthropicAccountsFixture.ts'
import { renderTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { describeRequest } from '../lib/scriptedTurn.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const world = await accountsWorld()
const project = join(world.home, 'project')
mkdirSync(project)
const { DEFAULT_PROJECT_CONFIG } = await import('../../src/utils/config/schema.ts')
world.config.saveGlobalConfig(current => ({ ...current, hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, projects: { [project]: { ...DEFAULT_PROJECT_CONFIG, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
world.auth.saveOAuthTokensIfNeeded(SUBSCRIPTION)
await world.auth.saveApiKey(KEY)
const pending = new Map<string, ServerResponse>()
const completed = new Set<string>()
let serial = 0
const send = (res: ServerResponse, turn: ScriptedTurn) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(renderTurn(turn, ++serial))
}
world.onMessage((body, res) => {
  if (!body.stream) return false
  const request = describeRequest(body, world.requests.length)
  const opening = request.opening.trim()
  if (opening === 'accounts crew alpha' || opening === 'accounts crew beta') {
    if (request.step === 0) pending.set(opening, res)
    else {
      completed.add(opening)
      send(res, { kind: 'text', text: `${opening} finished`, model: MODEL })
    }
    return true
  }
  if (opening === 'accounts crew parent' && request.step < 2) {
    const name = request.step === 0 ? 'alpha' : 'beta'
    send(res, { kind: 'tool_use', name: 'Crewmate', input: { name, description: `accounts ${name}`, prompt: `accounts crew ${name}`, model: MODEL, run_in_background: true }, model: MODEL })
    return true
  }
  return false
})
const frames: Record<string, unknown>[] = []
let stderr = ''
const root = resolve(import.meta.dir, '../..')
const distAt = process.argv.indexOf('--dist')
const host = hostRunner({
  node: Bun.which('node')!, dist: distAt < 0 ? join(root, 'dist/mercury.mjs') : process.argv[distAt + 1]!,
  argv: ['--model', MODEL, '--mode', 'sovereign', '--sovereign', '--allowed-tools', 'Crewmate', 'Bash'],
  cwd: project, home: world.home,
  env: { PATH: process.env.PATH, HOME: world.home, TMPDIR: process.env.TMPDIR, TERM: 'dumb',
    MERCURY_CONFIG_DIR: world.home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', ANTHROPIC_BASE_URL: world.base, MERCURY_ANTHROPIC_OAUTH_BASE: world.base,
  },
  onRow: row => frames.push(row),
})
host.child.stderr!.on('data', chunk => { stderr += chunk.toString() })
const wait = async (label: string, check: () => boolean) => {
  const until = Date.now() + 60_000
  while (!check()) {
    assert.ok(Date.now() < until, `${label}: ${JSON.stringify(frames.slice(-4))}\n${stderr.slice(-1000)}`)
    await new Promise(done => setTimeout(done, 20))
  }
}
try {
  await host.initialize()
  void host.prompt('accounts crew parent').catch(() => {})
  await wait('two real crewmates requesting', () => pending.size === 2)
  const first = world.requests.filter(row => row.path === '/v1/messages' && /^accounts crew (alpha|beta)$/.test(describeRequest(row.body, 0).opening.trim()))
  assert.equal(first.length, 2)
  assert.ok(first.every(row => row.bearer === `Bearer ${SUBSCRIPTION.accessToken}` && row.key === undefined))
  const file = join(world.home, '.mercury.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), anthropicPreferredSource: 'api-key' }))
  await wait('preference observed outside the runners', () => world.auth.readAnthropicPreferredSource() === 'api-key')
  for (const [name, res] of pending) send(res, { kind: 'tool_use', name: 'Bash', input: { command: 'printf fixture-step', description: name }, model: MODEL })
  pending.clear()
  await wait('both real crewmates continued', () => completed.size === 2)
  const next = world.requests.filter(row => row.path === '/v1/messages' && /^accounts crew (alpha|beta)$/.test(describeRequest(row.body, 0).opening.trim()) && describeRequest(row.body, 0).step > 0)
  assert.equal(next.length, 2)
  assert.ok(next.every(row => row.key === KEY && row.bearer === undefined && !row.beta.includes('oauth-2025-04-20')))
  await wait('both real crewmates settled', () => frames.filter(row => row.type === 'task' && row.state === 'ended').length >= 2)
  assert.ok(!frames.some(row => row.type === 'task' && row.state === 'ended' && row.status === 'failed'))
  console.log('PASS built runner launched two crewmates; both retained in-flight auth, continued on the key and finished')
} finally {
  for (const res of pending.values()) res.destroy()
  host.end()
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([host.exited, new Promise(done => { timer = setTimeout(() => { host.child.kill('SIGTERM'); done(null) }, 5000) })])
  clearTimeout(timer)
  if (host.child.exitCode === null) { host.child.kill('SIGKILL'); await host.exited }
  await world.close()
}
