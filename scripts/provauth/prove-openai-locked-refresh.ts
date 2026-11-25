#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rotatingTokenServer } from './lib/rotating-token-server.ts'
import type { CallModelParams } from '../../src/models/roads/callModelContract.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = join(proofHome, 'home')
mkdirSync(home)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
const server = rotatingTokenServer('rt-0')
process.env.MERCURY_OPENAI_AUTH_BASE = server.base
process.env.MERCURY_OPENAI_CHATGPT_BASE = server.base
process.env.MERCURY_OPENAI_API_BASE = server.base
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const accounts = await import('../../src/models/roads/openai/openaiAccounts.ts')
const { openaiCallModel } = await import('../../src/models/roads/openai/openaiCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')

const fixHint = 'fix currentSubscriptionTokens in src/models/roads/openai/openaiAccounts.ts (the road it hands the door) or the door in src/models/sign-in/lifecycle/lockedRefresh.ts; the stand-in token server is scripts/provauth/lib/rotating-token-server.ts'
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} — ${fixHint}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(what: string, holds: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what} — ${fixHint}`)
    await sleep(20)
  }
}

const authPath = accounts.openaiAuthPathForDisplay()
const accessUntil = (ms: number): string => `h.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + ms) / 1000) })).toString('base64url')}.s`
const EMAIL = 'row@example.invalid'
function seed(refreshToken: string, validForMs = -60_000): void {
  writeFileSync(authPath, JSON.stringify({ version: 1, preferredSource: 'chatgpt-subscription', tokens: { idToken: 'h.e30.s', accessToken: accessUntil(validForMs), refreshToken, email: EMAIL, planType: 'plus', accessTokenExpiresAtMs: Date.now() + validForMs } }, null, 2) + '\n', { mode: 0o600 })
}
const storedRefresh = (): string | undefined => (JSON.parse(readFileSync(authPath, 'utf8')) as { tokens?: { refreshToken?: string } }).tokens?.refreshToken
const liveToken = (): string => server.live ?? 'the grant is revoked'

type ChildEnd = { before?: string; after?: string; access?: string; stored?: string }
function child(onAbout: () => void): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'openai-refresh-child.ts')], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => {
      out += String(chunk)
      if (out.includes('"about":"refresh"')) onAbout()
    })
    proc.stderr.on('data', chunk => { err += String(chunk) })
    const overdue = setTimeout(() => proc.kill('SIGKILL'), 60_000)
    proc.on('close', code => {
      clearTimeout(overdue)
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '') as ChildEnd)
      } catch {
        reject(new Error(`the child ended rc=${code}: ${out.slice(-400)} ${err.slice(-400)}`))
      }
    })
  })
}

try {
  console.log('── two Mercury processes, one ChatGPT sign-in, a slow first exchange: one grant reaches the server ──')
  check('the proof writes under its own scratch home', authPath.startsWith(home), authPath)
  seed('rt-0')
  let release = server.hold()
  const first = child(() => {})
  await until('the first process has its grant at the server', () => server.grants.length === 1)
  let secondAsked = false
  const second = child(() => { secondAsked = true })
  await until('the second process has read the pair and asked to refresh it', () => secondAsked)
  await sleep(9_000)
  check('nine seconds on, with the first still exchanging, the second has sent nothing', server.grants.length === 1, `${server.grants.length} grants: ${JSON.stringify(server.grants.map(g => g.refreshToken))}`)
  release()
  const [a, b] = await Promise.all([first, second])
  check('both processes read the same pair before they refreshed', a.before === 'rt-0' && b.before === 'rt-0', JSON.stringify([a, b]))
  check('exactly one exchange reached the server and the grant was not revoked', server.grants.length === 1 && server.live === 'rt-1', `${server.grants.length} grants, live ${server.live}`)
  check('both processes end with the one live pair, and it is the stored one', a.after === 'rt-1' && b.after === 'rt-1' && a.access === b.access && storedRefresh() === 'rt-1', JSON.stringify({ a: a.after, b: b.after, stored: storedRefresh() }))
  const grant = server.grants[0]
  check('the grant on the wire is the one 1.1.0 sent: the same address, form fields and headers', grant?.path === '/oauth/token' && Object.keys(grant.form).sort().join(',') === 'client_id,grant_type,refresh_token' && grant.form.client_id === 'app_EMoamEEZ73f0CkXaXp7hrann' && grant.headers['content-type'] === 'application/x-www-form-urlencoded' && /^mercury\//.test(grant.headers['user-agent'] ?? ''), JSON.stringify({ path: grant?.path, form: Object.keys(grant?.form ?? {}), type: grant?.headers['content-type'], agent: grant?.headers['user-agent'] }))
  check('no lock is left beside the store', !existsSync(`${authPath}.lock`) && !existsSync(`${authPath}.refresh-lock`))

  console.log('── a new pair whose write fails is not lost: the next call never sends the spent token ──')
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    console.log('[SKIP] not staged on Windows or as root: chmod 0o500 does not stop a write into the home there')
  } else {
    const spent = 'rt-of-a-second-sign-in'
    server.live = spent
    seed(spent)
    const before = server.grants.length
    release = server.hold()
    const refusedWrite = accounts.currentSubscriptionTokens()
    await until('the grant is at the server', () => server.grants.length === before + 1)
    chmodSync(home, 0o500)
    release()
    const unsaved = await refusedWrite
    chmodSync(home, 0o700)
    const kept = liveToken()
    check('the store refused the write and still holds the spent token', storedRefresh() === spent && kept !== spent, `stored ${storedRefresh()}, spent ${spent}, live ${kept}`)
    check('the call answers the new pair all the same', unsaved?.refreshToken === kept, `answered ${unsaved?.refreshToken}, live ${kept}`)
    const next = await accounts.currentSubscriptionTokens()
    check('the next call answers the new pair again and sends nothing, so the grant stands', next?.refreshToken === kept && server.grants.length === before + 1 && server.live === kept, JSON.stringify({ answered: next?.refreshToken, sent: server.grants.slice(before + 1).map(g => g.refreshToken), live: server.live }))
    check('and now that the home can be written, that call landed the new pair in the store', storedRefresh() === kept, `stored ${storedRefresh()}, live ${kept}`)

    console.log('── a forced refresh whose write fails: the next ordinary call answers the new pair, not the one on disk ──')
    const replaced = 'rt-of-a-third-sign-in'
    server.live = replaced
    seed(replaced, 3_600_000)
    const beforeForced = server.grants.length
    release = server.hold()
    const forcedCall = accounts.currentSubscriptionTokens({ force: true })
    await until('the forced grant is at the server', () => server.grants.length === beforeForced + 1)
    chmodSync(home, 0o500)
    release()
    const rotated = await forcedCall
    chmodSync(home, 0o700)
    check('the forced call answers the new pair though the store refused the write and still holds a pair that reads fresh', rotated?.refreshToken === liveToken() && storedRefresh() === replaced && liveToken() !== replaced, JSON.stringify({ answered: rotated?.refreshToken, stored: storedRefresh(), live: server.live }))
    const ordinary = await accounts.currentSubscriptionTokens()
    check('the next ordinary call answers the new pair and sends nothing', ordinary?.refreshToken === liveToken() && ordinary.accessToken === rotated?.accessToken && server.grants.length === beforeForced + 1, JSON.stringify({ answered: ordinary?.refreshToken, live: server.live, grants: server.grants.length - beforeForced }))
  }

  console.log('── a turn cancelled while it waits for the lock is answered at once ──')
  const waitedFor = 'rt-of-a-fourth-sign-in'
  server.live = waitedFor
  seed(waitedFor)
  const beforeWait = server.grants.length
  release = server.hold()
  const holder = child(() => {})
  await until('the holding process has its grant at the server', () => server.grants.length === beforeWait + 1)
  const cancelled = new AbortController()
  const askedAt = Date.now()
  const waiting = accounts.resolveOpenaiRequestAuth({ sourceKind: 'chatgpt-subscription', signal: cancelled.signal })
  await sleep(300)
  cancelled.abort()
  const answered = await Promise.race([waiting.then(() => true), sleep(1_000).then(() => false)])
  check('the request for credentials returns within a second of the cancel, and sent nothing', answered && Date.now() - askedAt < 1_300 && server.grants.length === beforeWait + 1, `${Date.now() - askedAt} ms, ${server.grants.length - beforeWait} grants`)
  release()
  const holderEnd = await holder
  await waiting
  check('the holder still finishes its one exchange', holderEnd.after === liveToken() && storedRefresh() === liveToken() && server.grants.length === beforeWait + 1, JSON.stringify(holderEnd))

  console.log('── a whole turn cancelled while it waits for the lock ends there: it does not wait again for the model list ──')
  const turnToken = 'rt-of-a-fifth-sign-in'
  server.live = turnToken
  seed(turnToken)
  const beforeTurn = server.grants.length
  release = server.hold()
  const turnHolder = child(() => {})
  await until('the holding process has its grant at the server', () => server.grants.length === beforeTurn + 1)
  const escaped = new AbortController()
  const turnParams: CallModelParams = {
    messages: [createUserMessage({ content: 'say hi' })],
    systemPrompt: asSystemPrompt(['Fixture system']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: escaped.signal,
    options: { model: 'gpt', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false },
  }
  const rows: string[] = []
  const turn = (async (): Promise<void> => {
    for await (const item of openaiCallModel(turnParams)) rows.push(item.type)
  })()
  await sleep(300)
  const cancelledAt = Date.now()
  escaped.abort()
  const turnEnded = await Promise.race([turn.then(() => true), sleep(3_000).then(() => false)])
  check('the turn ends within three seconds of the cancel, says nothing, and sent nothing', turnEnded && rows.length === 0 && server.grants.length === beforeTurn + 1, JSON.stringify({ ended: turnEnded, ms: Date.now() - cancelledAt, rows, grants: server.grants.length - beforeTurn }))
  release()
  await turnHolder
  await turn
} finally {
  server.stop()
}
console.log(failures === 0 ? `\nOPENAI LOCKED REFRESH GREEN (${passes} checks; two real processes, a loopback token server, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
