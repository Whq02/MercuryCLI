#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rotatingTokenServer } from './lib/rotating-token-server.ts'

process.env.MERCURY_CONFIG_DIR = proofHome
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of Object.keys(process.env)) {
  if (ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) || /proxy/i.test(name)) delete process.env[name]
}
const kimiServer = rotatingTokenServer('rt-0')
const huggingfaceServer = rotatingTokenServer('rt-0')
const xaiServer = rotatingTokenServer('rt-0')
process.env.MERCURY_MOONSHOT_OAUTH_BASE = kimiServer.base
process.env.MERCURY_HUGGINGFACE_HUB_BASE = huggingfaceServer.base
process.env.MERCURY_XAI_AUTH_BASE = xaiServer.base
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const kimi = await import('../../src/models/roads/moonshot/moonshotAccounts.ts')
const huggingface = await import('../../src/models/roads/huggingface/huggingfaceAccounts.ts')
const xai = await import('../../src/models/roads/xai/xaiOauth.ts')
const xaiAccounts = await import('../../src/models/roads/xai/xaiAccounts.ts')

type Pair = { accessToken: string; refreshToken?: string }
type Road = {
  name: string
  child: 'kimi' | 'huggingface' | 'xai'
  server: ReturnType<typeof rotatingTokenServer>
  store: string
  seed: (refreshToken: string, expiresInMs?: number) => void
  refresh: () => Promise<Pair | undefined>
  resolve: () => Promise<string | undefined>
  grantPath: string
  clientId: string
  fix: string
}
const SEEDED_ACCESS = 'access-token-before-the-refresh'
const roads: Road[] = [
  {
    name: 'Kimi',
    child: 'kimi',
    server: kimiServer,
    store: kimi.moonshotAuthPathForDisplay(),
    seed: (refreshToken, expiresInMs = 30_000) => kimi.writeMoonshotTokens({ accessToken: SEEDED_ACCESS, refreshToken, accessTokenExpiresAtMs: Date.now() + expiresInMs }, 'global'),
    refresh: () => kimi.refreshMoonshotTokens(),
    resolve: () => kimi.resolveMoonshotDispatchCredential().then(credential => credential?.apiKey),
    grantPath: '/api/oauth/token',
    clientId: kimi.KIMI_OAUTH_CLIENT_ID,
    fix: 'fix refreshMoonshotTokens in src/models/roads/moonshot/moonshotAccounts.ts (the road it hands the door) or the door in src/models/sign-in/lifecycle/lockedRefresh.ts',
  },
  {
    name: 'Hugging Face',
    child: 'huggingface',
    server: huggingfaceServer,
    store: huggingface.huggingfaceAuthPathForDisplay(),
    seed: (refreshToken, expiresInMs = 30_000) => huggingface.writeHuggingfaceTokens({ accessToken: SEEDED_ACCESS, refreshToken, accessTokenExpiresAtMs: Date.now() + expiresInMs, clientId: 'fixture-client' }, { username: 'fixture-user', observedAtMs: Date.now() }),
    refresh: () => huggingface.refreshHuggingfaceTokens(),
    resolve: () => huggingface.resolveHuggingfaceDispatchCredential().then(credential => credential?.apiKey),
    grantPath: '/oauth/token',
    clientId: 'fixture-client',
    fix: 'fix refreshHuggingfaceTokens in src/models/roads/huggingface/huggingfaceAccounts.ts (the road it hands the door) or the door in src/models/sign-in/lifecycle/lockedRefresh.ts',
  },
  {
    name: 'xAI',
    child: 'xai',
    server: xaiServer,
    store: xai.xaiAuthPathForDisplay(),
    seed: (refreshToken, expiresInMs = 30_000) => xai.writeXaiTokens({ accessToken: SEEDED_ACCESS, refreshToken, expiresAtMs: Date.now() + expiresInMs }),
    refresh: () => xai.refreshXaiTokens(undefined, true).catch(() => undefined),
    resolve: () => xaiAccounts.resolveXaiCredential().then(credential => credential?.key),
    grantPath: '/oauth2/token',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    fix: 'fix refreshXaiTokens in src/models/roads/xai/xaiOauth.ts (the road it hands the door) or the door in src/models/sign-in/lifecycle/lockedRefresh.ts',
  },
]

let failures = 0
let passes = 0
let fixHint = ''
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} — ${fixHint}; the stand-in token server is scripts/provauth/lib/rotating-token-server.ts and the second process is scripts/provauth/lib/road-refresh-child.ts`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(what: string, holds: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what} — ${fixHint}`)
    await sleep(20)
  }
}

type ChildEnd = { before?: string; after?: string; access?: string; stored?: string }
function child(road: Road['child'], onAbout: () => void): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'road-refresh-child.ts'), road], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  for (const road of roads) {
    fixHint = road.fix
    const { server, store } = road
    const row = (): Pair | undefined => (existsSync(store) ? (JSON.parse(readFileSync(store, 'utf8')) as { tokens?: Pair }).tokens : undefined)
    const sent = (): string => `${server.grants.length} grants: ${JSON.stringify(server.grants.map(grant => grant.refreshToken))}, live ${server.live}`

    console.log(`── ${road.name}: two Mercury processes, one sign-in, a slow first exchange: one grant reaches the server ──`)
    check('the proof writes under its own scratch home', store.startsWith(proofHome), store)
    road.seed('rt-0')
    const release = server.hold()
    const mine = road.refresh()
    await until('this process has its grant at the server', () => server.grants.length >= 1)
    let peerAsked = false
    const peer = child(road.child, () => { peerAsked = true })
    await until('the second process has read the pair and asked to refresh it', () => peerAsked)
    await sleep(1_500)
    check('with the first still exchanging, the second process has sent nothing', server.grants.length === 1, sent())
    release()
    const [first, second] = await Promise.all([mine, peer])
    check('the second process read the pair the first was rotating', second.before === 'rt-0', JSON.stringify(second))
    check('exactly one exchange reached the server and the grant was not revoked', server.grants.length === 1 && server.live === 'rt-1', sent())
    check('both processes end with the one live pair, and it is the stored one', first?.refreshToken === 'rt-1' && second.after === 'rt-1' && second.access === first.accessToken && row()?.refreshToken === 'rt-1', JSON.stringify({ first: first?.refreshToken, second: second.after, stored: row()?.refreshToken }))
    const grant = server.grants[0]
    check('the grant on the wire is the one 1.1.0 sent: the same address, form fields and headers', grant?.path === road.grantPath && Object.keys(grant.form).sort().join(',') === 'client_id,grant_type,refresh_token' && grant.form.client_id === road.clientId && grant.headers['content-type'] === 'application/x-www-form-urlencoded' && grant.headers.accept === 'application/json' && /^mercury\//.test(grant.headers['user-agent'] ?? ''), JSON.stringify({ path: grant?.path, form: Object.keys(grant?.form ?? {}), client: grant?.form.client_id, type: grant?.headers['content-type'], agent: grant?.headers['user-agent'] }))
    check('no lock is left beside the store', !existsSync(`${store}.lock`))

    console.log(`── ${road.name}: two calls in one process share one exchange ──`)
    server.live = 'rt-joined'
    road.seed('rt-joined')
    const beforeJoined = server.grants.length
    const [one, two] = await Promise.all([road.refresh(), road.refresh()])
    check('one grant served both calls, and both hold the new pair', server.grants.length === beforeJoined + 1 && one?.refreshToken === server.live && two?.refreshToken === server.live && one?.accessToken === two?.accessToken, sent())

    console.log(`── ${road.name}: a token server that is down changes nothing; a refused grant keeps the row and is sent once ──`)
    const standing = server.live ?? ''
    const bytes = readFileSync(store, 'utf8')
    server.status = 503
    const down = await road.refresh()
    server.status = 200
    check('a 503 answers nothing and leaves the store byte for byte', down === undefined && readFileSync(store, 'utf8') === bytes && row()?.refreshToken === standing, JSON.stringify(row() ?? null))
    road.seed('rt-of-a-revoked-grant')
    const beforeRefused = server.grants.length
    const refused = await road.refresh()
    check('a refused refresh answers nothing and keeps the row, its refresh token blank', refused === undefined && row()?.refreshToken === '' && row()?.accessToken === SEEDED_ACCESS, JSON.stringify(row() ?? null))
    const again = await road.refresh()
    check('the refused token was sent once: the next call sends nothing', again === undefined && server.grants.length === beforeRefused + 1 && server.live === standing, sent())

    console.log(`── ${road.name}: a new pair the store would not take is the one the next resolve answers, and is never rotated again ──`)
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log('[SKIP] not staged on Windows or as root: chmod 0o500 does not stop a write into the home there')
      continue
    }
    const home = dirname(store)
    const withTheWriteRefused = async <T>(call: () => Promise<T>): Promise<T> => {
      const before = server.grants.length
      const letGo = server.hold()
      const calling = call()
      await until('the grant is at the server', () => server.grants.length === before + 1)
      chmodSync(home, 0o500)
      letGo()
      try {
        return await calling
      } finally {
        chmodSync(home, 0o700)
        rmSync(`${store}.lock`, { recursive: true, force: true })
      }
    }
    server.live = 'rt-inside-its-margin'
    road.seed('rt-inside-its-margin')
    const beforeRotated = server.grants.length
    const rotated = await withTheWriteRefused(() => road.resolve())
    const unsaved = server.live
    check('the store refused the new pair and still holds the old one; the resolve answers the new access token all the same', row()?.refreshToken === 'rt-inside-its-margin' && unsaved !== 'rt-inside-its-margin' && rotated !== undefined && rotated !== SEEDED_ACCESS, JSON.stringify({ stored: row()?.refreshToken, live: unsaved, answeredTheOldAccessToken: rotated === SEEDED_ACCESS, answeredNothing: rotated === undefined }))
    const resolvedAgain = await road.resolve()
    check('the next resolve answers that pair again and sends nothing: a pair just received is not exchanged a second time', resolvedAgain === rotated && server.grants.length === beforeRotated + 1 && server.live === unsaved, sent())
    check('and now that the home can be written, that pair is in the store', row()?.refreshToken === unsaved, JSON.stringify({ stored: row()?.refreshToken, unsaved }))

    server.live = 'rt-of-a-pair-that-reads-fresh'
    road.seed('rt-of-a-pair-that-reads-fresh', 3_600_000)
    const beforeForced = server.grants.length
    const forced = await withTheWriteRefused(() => road.refresh())
    check('a forced refresh (the retry after a 401) answers the new pair though the store refused it and still holds one that reads fresh', forced?.refreshToken === server.live && forced?.accessToken !== SEEDED_ACCESS && row()?.refreshToken === 'rt-of-a-pair-that-reads-fresh', JSON.stringify({ answered: forced?.refreshToken, stored: row()?.refreshToken, live: server.live }))
    const resolvedAfterForced = await road.resolve()
    check('the next resolve answers the new pair, not the one on disk, and sends nothing', resolvedAfterForced !== undefined && resolvedAfterForced === forced?.accessToken && server.grants.length === beforeForced + 1, JSON.stringify({ answeredTheOldAccessToken: resolvedAfterForced === SEEDED_ACCESS, answeredTheNewOne: resolvedAfterForced === forced?.accessToken, grants: server.grants.length - beforeForced }))
  }
} finally {
  kimiServer.stop()
  huggingfaceServer.stop()
  xaiServer.stop()
}
console.log(failures === 0 ? `\nROADS ON THE LOCKED REFRESH GREEN (${passes} checks; ${roads.length} roads, two real processes each, loopback token servers, no live host)` : `\n${failures} FAILURE(S) of ${passes + failures}`)
process.exit(failures === 0 ? 0 : 1)
