#!/usr/bin/env bun
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
const home = mkdtempSync(join(tmpdir(), 'roles-affinity-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.argv.push(`--debug-file=${join(home, 'debug.txt')}`)
let reply: ServerResponse | undefined
let received: (() => void) | undefined
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/oauth/claude_cli/roles')) {
    reply = res
    received?.()
  } else {
    res.writeHead(404).end()
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('fixture has no port')
process.env.MERCURY_CUSTOM_OAUTH_URL = `http://127.0.0.1:${address.port}`
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { getGlobalConfig } = await import('../../src/utils/config.js')
const { fetchAndStoreUserRoles, storeOAuthAccountInfo } = await import('../../src/services/oauth/client.js')
const { getAuthScope, setAuthScope, clearAuthScope } = await import('../../src/utils/envUtils.js')
const { createAnthropicLoginMachine } = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.js')
const { flushDebugLogs } = await import('../../src/utils/debug.js')
const A = { accountUuid: 'account-a', emailAddress: 'a@fixture.example', organizationUuid: 'org-a' }
const B = { accountUuid: 'account-b', emailAddress: 'b@fixture.example', organizationUuid: 'org-b', organizationName: 'B', organizationRole: 'member', workspaceRole: 'member' }
const roles = { organization_name: 'A', organization_role: 'admin', workspace_role: 'admin' }
const account = () => getGlobalConfig().oauthAccount
const release = (): void => { reply!.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(roles)); reply = undefined }
const waitRequest = (): Promise<void> => new Promise(resolve => { received = resolve })
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}: ${JSON.stringify(account())}`)
}
try {
  for (const kind of ['same', 'account', 'organization', 'scope']) {
    clearAuthScope()
    storeOAuthAccountInfo(A)
    const request = waitRequest()
    const pending = fetchAndStoreUserRoles('fixture-access-a')
    await request
    if (kind === 'account') storeOAuthAccountInfo(B)
    if (kind === 'organization') storeOAuthAccountInfo({ ...A, organizationUuid: 'org-other' })
    if (kind === 'scope') setAuthScope(join(home, 'other-scope'))
    const before = JSON.stringify(account())
    console.log(`[record] ${kind} before reply: ${before}`)
    release()
    await pending
    check(`${kind}: roles only enrich the originating account and scope`, kind === 'same' ? account()?.organizationName === 'A' : JSON.stringify(account()) === before)
  }
  clearAuthScope()
  for (const action of ['keep', 'reset', 'dispose', 'switch-before-start']) {
    let pending: Promise<unknown> | undefined
    let resolved!: () => void
    const ready = new Promise<void>(resolve => { resolved = resolve })
    const request = waitRequest()
    const machine = createAnthropicLoginMachine({ onDone: () => {} }, snap => {
      if (snap.flow.name === 'success') {
        if (action === 'switch-before-start') storeOAuthAccountInfo(B)
        resolved()
      }
    }, {
      createService: () => ({ startOAuthFlow: async () => ({ accessToken: 'fixture-access-a', scopes: ['user:profile', 'user:inference'], tokenAccount: { uuid: A.accountUuid, emailAddress: A.emailAddress, organizationUuid: A.organizationUuid } }) as never, handleManualAuthCodeInput: () => {}, cleanup: () => {} }),
      saveTokens: () => ({ success: true }), usesClaudeAiAuth: () => true,
      storeAccount: storeOAuthAccountInfo,
      fetchRoles: (...args: unknown[]) => pending = (fetchAndStoreUserRoles as (...args: unknown[]) => Promise<void>)(...args),
      settings: () => ({}), recordSignIn: () => {}, shadowWarning: () => null, log: () => {},
    })
    machine.start(true)
    await ready
    await settle()
    check(`${action}: login completed without awaiting roles`, machine.snapshot().flow.name === 'success')
    await Promise.race([request, pending ?? Promise.resolve()])
    if (action === 'reset') machine.reset()
    if (action === 'dispose') machine.dispose()
    const before = JSON.stringify(account())
    if (reply) release()
    await pending
    check(`${action}: the detached tail obeys account and generation`, action === 'keep' ? account()?.organizationName === 'A' : JSON.stringify(account()) === before)
    machine.dispose()
  }
  await flushDebugLogs()
  const debug = existsSync(join(home, 'debug.txt')) ? readFileSync(join(home, 'debug.txt'), 'utf8') : ''
  check('stale replies are recorded only in the debug channel', debug.includes('OAuth roles response ignored'))
  check('the scope bracket is restored', getAuthScope() === undefined)
} finally {
  reply?.end('{}')
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
