#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — change mcpRemoveHandler in src/commands/verbs/mcp.tsx (the mercury mcp remove verb) so its exit code, its words, the token revoke requests and the local token clearing match this check${detail ? `; ${detail}` : ''}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-remove-revokes-')))
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
const LATE = 'The authorization server of probe did not answer within 10 s, so its tokens may stay valid there until they expire; the local copies are cleared.'

type Seen = { at: number; method: string; path: string; body: string }
type Stand = { base: string; seen: Seen[]; close: () => Promise<void> }

async function standIn(answers: 'promptly' | 'never'): Promise<Stand> {
  const seen: Seen[] = []
  const held: ServerResponse[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!
      seen.push({ at: Date.now(), method: req.method ?? '', path, body: Buffer.concat(chunks).toString('utf8') })
      if (answers === 'never') {
        held.push(res)
        return
      }
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.method === 'GET' && path.startsWith('/.well-known/oauth-authorization-server')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], revocation_endpoint: `${base}/revoke` }))
        return
      }
      if (req.method === 'POST' && path === '/revoke') {
        res.writeHead(200).end()
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>(done => {
        for (const res of held) res.destroy()
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

const PRELUDE = (home: string, cwd: string, store: 'file' | 'keychain' = 'file'): string => `
  process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
  ${store === 'file' ? `process.env.MERCURY_CREDENTIAL_STORE = 'file'` : 'delete process.env.MERCURY_CREDENTIAL_STORE'}
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  delete process.env.MERCURY_HOME
  delete process.env.NODE_ENV
  globalThis.MACRO = { VERSION: '1.0.0' }
  process.chdir(${JSON.stringify(cwd)})
  const { enableConfigs } = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
  enableConfigs()
  const bootstrap = await import(${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))})
  bootstrap.setOriginalCwd(${JSON.stringify(cwd)})
  const config = await import(${JSON.stringify(join(SRC, 'integrations/mcp/serverConfigs.ts'))})
  const auth = await import(${JSON.stringify(join(SRC, 'integrations/mcp/auth.ts'))})
  const { getSecureStorage } = await import(${JSON.stringify(join(SRC, 'platform/secure-storage/index.ts'))})
`

type Run = { code: number | null; stdout: string; stderr: string; seconds: number; seenBeforeExit: Seen[]; seenAfter: Seen[]; tokensLeft: string[]; configured: boolean; world: string; store: string }

async function remove(stand: Stand, opts: { scope: boolean; tokens: boolean; storeTakesNoWrite?: boolean; storeUnreadable?: boolean; projectFileTakesNoWrite?: boolean; keychainAnswersNothing?: boolean; again?: string }): Promise<Run> {
  const world = opts.again ?? mkdtempSync(join(scratch, 'world-'))
  const home = join(world, 'home')
  const cwd = join(world, 'project')
  const store = join(home, '.credentials.json')
  for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' }
  const acted: Record<string, string | undefined> = { ...env }
  if (opts.keychainAnswersNothing === true) {
    const bin = join(world, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'security'), `#!/bin/sh\nif [ "$1" = "-i" ]; then cat >/dev/null; fi\nexit 44\n`)
    chmodSync(join(bin, 'security'), 0o755)
    acted.PATH = `${bin}:${process.env.PATH ?? ''}`
    delete acted.MERCURY_CREDENTIAL_STORE
  }
  const server = `{ type: 'http', url: ${JSON.stringify(`${stand.base}/mcp`)} }`
  const held = opts.projectFileTakesNoWrite === true ? 'project' : 'user'
  const projectFolder = join(cwd, '.mercury')
  const src = `
    ${PRELUDE(home, cwd, opts.keychainAnswersNothing === true ? 'keychain' : 'file')}
    const handlers = await import(${JSON.stringify(join(SRC, 'commands/verbs/mcp.tsx'))})
    const server = ${server}
    if (${opts.again === undefined}) await config.addMcpConfig('probe', server, ${JSON.stringify(held)})
    if (${opts.tokens && opts.again === undefined}) {
      const stored = getSecureStorage().update({ mcpOAuth: { [auth.getServerKey('probe', server)]: { serverName: 'probe', serverUrl: server.url, accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 3600000, clientId: 'fixture-client', discoveryState: { authorizationServerUrl: ${JSON.stringify(stand.base)} } } } })
      if (!stored.success) throw new Error('the fixture tokens were not stored')
    }
    if (${opts.storeTakesNoWrite === true}) (await import('node:child_process')).spawnSync('/usr/bin/chflags', ['uchg', ${JSON.stringify(store)}])
    if (${opts.storeUnreadable === true}) (await import('node:fs')).chmodSync(${JSON.stringify(store)}, 0o200)
    if (${opts.projectFileTakesNoWrite === true}) (await import('node:fs')).chmodSync(${JSON.stringify(projectFolder)}, 0o555)
    await handlers.mcpRemoveHandler('probe', ${opts.scope ? `{ scope: ${JSON.stringify(held)} }` : '{}'})
  `
  const startedAt = Date.now()
  const child = spawn(BUN, ['-e', src], { env: acted, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => (stdout += String(chunk)))
  child.stderr.on('data', chunk => (stderr += String(chunk)))
  const code = await new Promise<number | null>(done => child.on('exit', exit => done(exit)))
  const exitedAt = Date.now()
  if (opts.storeTakesNoWrite === true) spawnSync('/usr/bin/chflags', ['nouchg', store])
  if (opts.storeUnreadable === true) chmodSync(store, 0o600)
  if (opts.projectFileTakesNoWrite === true) chmodSync(projectFolder, 0o755)
  const seenBeforeExit = [...stand.seen]
  await new Promise<void>(done => setTimeout(done, 1500))
  const after = spawnSync(BUN, ['-e', `
    ${PRELUDE(home, cwd)}
    const left = Object.keys(getSecureStorage().read()?.mcpOAuth ?? {})
    process.stdout.write('\\n' + JSON.stringify({ left, configured: Object.hasOwn(config.getMcpConfigsByScope(${JSON.stringify(held)}).servers, 'probe') }))
    process.exit(0)
  `], { env, encoding: 'utf8' })
  const facts = JSON.parse(after.stdout.trim().split('\n').pop() ?? '{}') as { left?: string[]; configured?: boolean }
  return { code, stdout, stderr, seconds: (exitedAt - startedAt) / 1000, seenBeforeExit, seenAfter: stand.seen.slice(seenBeforeExit.length), tokensLeft: facts.left ?? ['(the store was not read)'], configured: facts.configured ?? true, world, store }
}
const lines = (seen: Seen[]): string => seen.map(row => `${row.method} ${row.path}${row.body ? ` ${row.body.replace(/token=[^&]+/, 'token=…')}` : ''}`).join(' · ') || 'no request at all'
const revoked = (seen: Seen[], token: string, hint: string): boolean => seen.some(row => row.method === 'POST' && row.path === '/revoke' && row.body.includes(`token=${token}`) && row.body.includes(`token_type_hint=${hint}`))

try {
  for (const scope of [true, false]) {
    console.log(`mercury mcp remove probe${scope ? ' --scope user' : ''} — a server whose tokens are stored, an authorization server that answers`)
    const stand = await standIn('promptly')
    const run = await remove(stand, { scope, tokens: true })
    await stand.close()
    check('the verb ends 0 and says what it removed', run.code === 0 && run.stdout.includes('Removed MCP server probe from user scope') && run.stdout.includes('Modified: the user config') && !run.configured, `exit ${run.code} · ${run.stdout.trim()} · ${run.stderr.trim()}`)
    check('before the process exits, the authorization server is asked for its metadata', run.seenBeforeExit.some(row => row.method === 'GET' && row.path.startsWith('/.well-known/')), lines(run.seenBeforeExit))
    check('…and both tokens are revoked there, the refresh token and the access token', revoked(run.seenBeforeExit, 'fixture-refresh-token', 'refresh_token') && revoked(run.seenBeforeExit, 'fixture-access-token', 'access_token'), `${lines(run.seenBeforeExit)} — the tokens stay valid on the server after the remove`)
    check('the local tokens are cleared', run.tokensLeft.length === 0, run.tokensLeft.join(', '))
    check('nothing is said of a server that answered, and the verb does not wait its bound', !run.stderr.includes('did not answer') && run.seconds < 8, `${run.seconds}s · ${run.stderr.trim()}`)
  }

  console.log('mercury mcp remove probe --scope user — an authorization server that never answers')
  {
    const stand = await standIn('never')
    const run = await remove(stand, { scope: true, tokens: true })
    await stand.close()
    check('the request is sent before the process exits', run.seenBeforeExit.length >= 1, lines(run.seenBeforeExit))
    check('the verb waits its bound and no longer, then ends 0', run.code === 0 && run.seconds >= 9 && run.seconds < 20, `exit ${run.code} after ${run.seconds}s`)
    check('it says in one line that the server did not answer in time', run.stderr.split('\n').filter(line => line === LATE).length === 1, run.stderr.trim() || '(stderr is empty)')
    check('it still says what it removed, and the local tokens are cleared either way', run.stdout.includes('Removed MCP server probe from user scope') && run.stdout.includes('Modified: the user config') && run.tokensLeft.length === 0 && !run.configured, `${run.stdout.trim()} · left ${run.tokensLeft.join(', ')}`)
  }

  console.log('mercury mcp remove probe --scope user — a credential store that takes no write: it says so and exits 1, and the same command later finishes')
  if (process.platform !== 'darwin' || (typeof process.getuid === 'function' && process.getuid() === 0)) console.log('  [SKIP] the write that fails — a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const stand = await standIn('promptly')
    const refused = await remove(stand, { scope: true, tokens: true, storeTakesNoWrite: true })
    const words = `The credential store at ${refused.store} could not be written (EPERM); the tokens of probe are still stored here. Close what holds the file, then run the command again.`
    check('the verb ends 1 and says in one line that the store could not be written and what to do', refused.code === 1 && refused.stderr.split('\n').filter(line => line !== '').join('\n') === words, `exit ${refused.code} · stderr: ${refused.stderr.trim() || '(empty)'}`)
    check('it says neither that it removed the server nor that the local copies are cleared', !refused.stdout.includes('Removed MCP server') && !refused.stdout.includes('Modified:') && !refused.stderr.includes('the local copies are cleared'), refused.stdout.trim())
    check('the tokens are still stored, the server is still configured, and nothing was revoked', refused.tokensLeft.length === 1 && refused.configured && ![...refused.seenBeforeExit, ...refused.seenAfter].some(row => row.path === '/revoke'), `left ${refused.tokensLeft.join(', ') || 'nothing'} · configured ${refused.configured} · ${lines([...refused.seenBeforeExit, ...refused.seenAfter])}`)
    const seenBefore = stand.seen.length
    const again = await remove(stand, { scope: true, tokens: true, again: refused.world })
    await stand.close()
    const asked = stand.seen.slice(seenBefore)
    check('the same command, once the store takes a write, removes the server, revokes both tokens and clears them', again.code === 0 && again.stdout.includes('Modified: the user config') && !again.configured && again.tokensLeft.length === 0 && revoked(asked, 'fixture-refresh-token', 'refresh_token') && revoked(asked, 'fixture-access-token', 'access_token'), `exit ${again.code} · ${again.stdout.trim()} · ${again.stderr.trim()} · left ${again.tokensLeft.join(', ')} · ${lines(asked)}`)
  }

  console.log('mercury mcp remove probe --scope user — a credential store that is there and cannot be read: the store\'s own sentence, exit 1, nothing removed')
  if (!POSIX_MODES) console.log('  [SKIP] the unreadable store — a mode-0200 file needs a POSIX process that is not root')
  else {
    const stand = await standIn('promptly')
    const refused = await remove(stand, { scope: true, tokens: true, storeUnreadable: true })
    const words = `The credential store at ${refused.store} exists but could not be read (EACCES); nothing was written.`
    check('the verb ends 1 with the store\'s own sentence, removes nothing and leaves the tokens', refused.code === 1 && refused.stderr.split('\n').filter(line => line !== '').join('\n') === words && !refused.stdout.includes('Removed MCP server') && refused.configured && refused.tokensLeft.length === 1, `exit ${refused.code} · stdout: ${refused.stdout.trim() || '(empty)'} · stderr: ${refused.stderr.trim() || '(empty)'} · configured ${refused.configured} · left ${refused.tokensLeft.join(', ') || 'nothing'}`)
    const again = await remove(stand, { scope: true, tokens: true, again: refused.world })
    await stand.close()
    check('the same command, once the store reads, removes the server and clears the tokens', again.code === 0 && !again.configured && again.tokensLeft.length === 0, `exit ${again.code} · ${again.stdout.trim()} · ${again.stderr.trim()} · left ${again.tokensLeft.join(', ')}`)
  }

  console.log('mercury mcp remove probe --scope user — a keychain that holds nothing and a credential file that cannot be read (a Mac as it comes): the same refusal, nothing removed')
  if (process.platform !== 'darwin' || !POSIX_MODES) console.log('  [SKIP] the keychain beside the unreadable file — the keychain tool is stood in for on macOS only, and a mode-0200 file needs a process that is not root')
  else {
    const stand = await standIn('promptly')
    const refused = await remove(stand, { scope: true, tokens: true, storeUnreadable: true, keychainAnswersNothing: true })
    await stand.close()
    const words = `The credential store at ${refused.store} exists but could not be read (EACCES); nothing was written.`
    check('the verb ends 1 with the store\'s own sentence, removes nothing and leaves the tokens in the file', refused.code === 1 && refused.stderr.split('\n').filter(line => line !== '').join('\n') === words && !refused.stdout.includes('Removed MCP server') && refused.configured && refused.tokensLeft.length === 1, `exit ${refused.code} · stdout: ${refused.stdout.trim() || '(empty)'} · stderr: ${refused.stderr.trim() || '(empty)'} · configured ${refused.configured} · left ${refused.tokensLeft.join(', ') || 'nothing'}`)
  }

  console.log('mercury mcp remove probe --scope project — the project file takes no write once the tokens are cleared: they are revoked before the verb says why and exits 1')
  if (!POSIX_MODES) console.log('  [SKIP] the project file that takes no write — a folder that takes no new file needs a POSIX process that is not root')
  else {
    const stand = await standIn('promptly')
    const run = await remove(stand, { scope: true, tokens: true, projectFileTakesNoWrite: true })
    await stand.close()
    check('the verb exits 1 with the config\'s own sentence, the entry stands, and the tokens are cleared here and revoked there before it exits', run.code === 1 && run.stderr.includes('Failed to write to ') && !run.stdout.includes('Removed MCP server') && run.configured && run.tokensLeft.length === 0 && revoked(run.seenBeforeExit, 'fixture-refresh-token', 'refresh_token') && revoked(run.seenBeforeExit, 'fixture-access-token', 'access_token'), `exit ${run.code} · ${run.stdout.trim()} · ${run.stderr.trim()} · configured ${run.configured} · left ${run.tokensLeft.join(', ') || 'nothing'} · ${lines(run.seenBeforeExit)}`)
  }

  console.log('mercury mcp remove probe --scope user — control: a server with no stored tokens has nothing to revoke')
  {
    const stand = await standIn('promptly')
    const run = await remove(stand, { scope: true, tokens: false })
    await stand.close()
    check('the verb ends 0 at once, asks the server nothing and says nothing of it', run.code === 0 && run.seenBeforeExit.length === 0 && run.seenAfter.length === 0 && !run.stderr.includes('did not answer') && run.seconds < 8 && !run.configured, `exit ${run.code} after ${run.seconds}s · ${lines(run.seenBeforeExit)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
