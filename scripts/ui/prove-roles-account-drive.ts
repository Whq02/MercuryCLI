#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '../..')
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const BIN = arg('--dist') ?? join(REPO, 'dist/mercury.mjs')
const OUT = arg('--records')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'roles-account-')))
const home = join(root, 'home')
const cwd = join(root, 'project')
mkdirSync(cwd)
seedFirstRun(home, [cwd])
writeFileSync(join(home, 'settings.json'), '{}')
const node = existsSync(join(dirname(BIN), 'vendor/node/bin/node')) ? join(dirname(BIN), 'vendor/node/bin/node') : 'node'
const wire: unknown[] = []
let held: ServerResponse | undefined
let arrived!: () => void
const request = new Promise<void>(resolve => { arrived = resolve })
const server = createServer((req, res) => {
  const parts: Buffer[] = []
  req.on('data', part => parts.push(part))
  req.on('end', () => {
    const body = Buffer.concat(parts).toString()
    const account = `${body} ${req.headers.authorization ?? ''}`.includes('fixture-b') ? 'b' : 'a'
    const url = req.url ?? ''
    wire.push({ url, account })
    const json = (data: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data)) }
    if (url.startsWith('/v1/oauth/token')) return json({ access_token: `fixture-${account}`, refresh_token: `fixture-${account}`, expires_in: 3600, scope: 'user:profile user:inference', account: { uuid: `account-${account}`, email_address: `${account}@fixture.example` }, organization: { uuid: `org-${account}` } })
    if (url.startsWith('/api/oauth/profile')) return json({ account: { uuid: `account-${account}`, email: `${account}@fixture.example` }, organization: { uuid: `org-${account}`, organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' } })
    if (url.startsWith('/api/oauth/claude_cli/roles')) {
      if (account === 'a') { held = res; arrived(); return }
      return json({ organization_name: 'B', organization_role: 'member', workspace_role: 'member' })
    }
    res.writeHead(404).end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('fixture has no port')
const children: ChildProcess[] = []
function login(account: string): Promise<{ rc: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_OAUTH_REFRESH_TOKEN: `fixture-${account}`, MERCURY_OAUTH_SCOPES: 'user:profile user:inference', MERCURY_CUSTOM_OAUTH_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0' }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_HOME', 'NODE_ENV']) delete (env as Record<string, unknown>)[key]
  const child = spawn(node, [BIN, 'auth', 'login'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  return new Promise(resolve => child.on('exit', rc => resolve({ rc, stdout, stderr })))
}
const readAccount = (): unknown => JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')).oauthAccount
const guard = setTimeout(() => { for (const child of children) child.kill('SIGTERM'); held?.end('{}') }, vshotBudgetMs(90_000))
try {
  console.log(`bundle ${BIN}; scratch ${root}`)
  const first = login('a')
  await Promise.race([request, first.then(value => { throw new Error(`first login exited before roles: ${JSON.stringify(value)}`) })])
  const beforeSwitch = readAccount()
  const second = await login('b')
  const beforeReply = readAccount()
  const interval = Number(/const CONFIG_FRESHNESS_POLL_MS = (\d+)/.exec(readFileSync(join(REPO, 'src/utils/config/globalConfig.ts'), 'utf8'))?.[1])
  if (!interval) throw new Error('the config freshness cadence is not available')
  await new Promise(resolve => setTimeout(resolve, interval * 2))
  held!.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ organization_name: 'A', organization_role: 'admin', workspace_role: 'admin' }))
  held = undefined
  const firstResult = await first
  const afterReply = readAccount()
  const record = { bundle: BIN, beforeSwitch, beforeReply, afterReply, first: firstResult, second, wire }
  console.log(JSON.stringify(record, null, 2))
  if (OUT) writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n')
  const ok = second.rc === 0 && firstResult.rc === 0 && (beforeSwitch as { accountUuid?: string }).accountUuid === 'account-a' && (beforeReply as { accountUuid?: string }).accountUuid === 'account-b' && (beforeReply as { organizationName?: string }).organizationName === 'B' && JSON.stringify(afterReply) === JSON.stringify(beforeReply)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] the late roles response leaves the account that signed in next unchanged`)
  process.exitCode = ok ? 0 : 1
} finally {
  clearTimeout(guard)
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  held?.end('{}')
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}
