#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const launchDir = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-path-floors-')))
const HOME = join(scratch, 'home')
const STORE = join(scratch, 'mercury-home')
const PROJ = join(scratch, 'proj')
for (const dir of [HOME, STORE, PROJ]) mkdirSync(dir, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(PROJ)

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { setOriginalCwd, setCwdState, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { checkReadPermissionForTool, checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')
const { noteResolvedAuthority } = await import('../../src/services/remoteFiles/target.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(PROJ)
setCwdState(PROJ)

type Ctx = import('../../src/Tool.ts').ToolPermissionContext
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string } }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const context = (mode = 'default', allow: string[] = []): Ctx =>
  ({ ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysAllowRules: allow.length > 0 ? { userSettings: allow } : {} }) as unknown as Ctx
const tool = (name: string) => ({ name, getPath: (input: { file_path?: string }) => input.file_path })
const read = (name: string, path: string, ctx: Ctx = context()): Decision => checkReadPermissionForTool(tool(name), { file_path: path }, ctx) as unknown as Decision
const write = (name: string, path: string, ctx: Ctx = context()): Decision => checkWritePermissionForTool(tool(name), { file_path: path }, ctx) as unknown as Decision
const said = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`

const SECRET = join(STORE, '.credentials.json')
const RUNTIME = join(STORE, 'runtime', 'current', 'mercury.mjs')
const KEYS = join(HOME, '.ssh', 'authorized_keys')
const interfaceAddress = Object.values(networkInterfaces()).flatMap(rows => rows ?? []).find(row => row.family === 'IPv4' && !row.internal)?.address
const ownName = hostname()
const HERE = [
  'localhost',
  'LOCALHOST',
  'dev.localhost',
  '127.0.0.1',
  '127.9.8.7',
  '127.1',
  '2130706433',
  '0x7f000001',
  '0.0.0.0',
  '[::1]',
  '[0:0:0:0:0:0:0:1]',
  '[::ffff:127.0.0.1]',
  'someone@localhost:2222',
  ...(/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(ownName) ? [ownName] : []),
  ...(interfaceAddress === undefined ? [] : [interfaceAddress]),
]
const ELSEWHERE = ['web1', '192.0.2.7', 'localhost.example.com', 'notlocalhost', '[2001:db8::7]', '198.51.100.9']

section('§1 the two floors as a local path meets them')
const localRead = read('Read', SECRET)
const localRuntime = write('Edit', RUNTIME)
const localKeys = write('Write', KEYS)
check('reading the credential store is refused', localRead.behavior === 'deny' && /holds Mercury's own credentials/.test(localRead.message ?? ''), said(localRead))
check('writing into the runtime is refused', localRuntime.behavior === 'deny' && /is part of Mercury’s running runtime\.$/.test(localRuntime.message ?? ''), said(localRuntime))
check('writing a credential path is refused', localKeys.behavior === 'deny' && /is a protected system or credential path\.$/.test(localKeys.message ?? ''), said(localKeys))
const sentenceFor = (local: Decision, localPath: string, remotePath: string): string => (local.message ?? '').replace(localPath, remotePath)

section('§2 the same file through a remote path that names this machine: the same refusal, in the same sentence')
for (const host of HERE) {
  const secret = `ssh://${host}${SECRET}`
  const runtime = `ssh://${host}${RUNTIME}`
  const keys = `ssh://${host}${KEYS}`
  const readers = ['Read', 'Grep', 'Glob'].map(name => read(name, secret))
  check(`${host}: the credential store is refused to Read, Grep and Glob`, readers.every(decision => decision.behavior === 'deny' && decision.message === sentenceFor(localRead, SECRET, secret)), readers.map(said).join(' · '))
  const writers = ['Edit', 'Write'].map(name => write(name, runtime))
  check(`${host}: a write into the runtime is refused to Edit and Write`, writers.every(decision => decision.behavior === 'deny' && decision.message === sentenceFor(localRuntime, RUNTIME, runtime)), writers.map(said).join(' · '))
  const keyWriters = ['Edit', 'Write'].map(name => write(name, keys))
  check(`${host}: a write to a credential path is refused`, keyWriters.every(decision => decision.behavior === 'deny' && decision.message === sentenceFor(localKeys, KEYS, keys)), keyWriters.map(said).join(' · '))
}

section('§3 a configuration name whose host is this machine')
{
  const before = read('Read', `ssh://self${SECRET}`)
  check('a name not yet resolved is judged as the name it is', before.behavior === 'ask', said(before))
  noteResolvedAuthority({ host: 'self' }, { hostname: '127.0.0.1', user: 'me', port: 22 })
  noteResolvedAuthority({ host: 'box' }, { hostname: 'LocalHost' })
  for (const name of ['self', 'box']) {
    const after = read('Read', `ssh://${name}${SECRET}`)
    check(`${name}, resolved to this machine: the credential store is refused`, after.behavior === 'deny' && after.message === sentenceFor(localRead, SECRET, `ssh://${name}${SECRET}`), said(after))
    const runtime = write('Edit', `ssh://${name}${RUNTIME}`)
    check(`${name}, resolved to this machine: a write into the runtime is refused`, runtime.behavior === 'deny', said(runtime))
  }
}

section('§4 the home spelling')
{
  mkdirSync(join(HOME, '.mercury'), { recursive: true })
  const own = read('Read', 'ssh://localhost/~/.mercury/.credentials.json')
  check('the store under the home of this account', own.behavior === 'deny' && /holds Mercury's own credentials/.test(own.message ?? ''), said(own))
  const other = read('Read', 'ssh://someone@localhost/~/.mercury/browser-secrets.json')
  check('the store under the home of another account of this machine', other.behavior === 'deny', said(other))
  const named = read('Read', 'ssh://localhost/~someone/.mercury/.provider-secrets.json')
  check('the store under a named home', named.behavior === 'deny', said(named))
  const keys = write('Edit', 'ssh://localhost/~/.ssh/config')
  check('a credential path under the home', keys.behavior === 'deny' && /is a protected system or credential path\.$/.test(keys.message ?? ''), said(keys))
}

section('§5 another host, the same shape of path: not refused')
for (const host of ELSEWHERE) {
  const secret = read('Read', `ssh://${host}${SECRET}`)
  const runtime = write('Edit', `ssh://${host}${RUNTIME}`)
  const keys = write('Write', `ssh://${host}${KEYS}`)
  check(`${host}: the ordinary ask for all three`, [secret, runtime, keys].every(decision => decision.behavior === 'ask' && decision.decisionReason?.type === 'workingDir'), [secret, runtime, keys].map(said).join(' · '))
}

section('§6 on this machine, a file no floor holds is the ordinary ask')
{
  const hosts = read('Read', 'ssh://localhost/etc/hosts')
  const notes = write('Edit', `ssh://localhost${join(PROJ, 'notes.txt')}`)
  check('a read', hosts.behavior === 'ask' && hosts.message === 'Permission to read from ssh://localhost/etc/hosts has not been granted.', said(hosts))
  check('a write', notes.behavior === 'ask', said(notes))
  const named = context('default', [`Edit(/${KEYS})`])
  const local = write('Edit', KEYS, named)
  const remote = write('Edit', `ssh://localhost${KEYS}`, named)
  check('a credential path the user granted by its exact name is no longer refused, here as locally', local.behavior === 'allow' && remote.behavior === 'ask', `${said(local)} · ${said(remote)}`)
  const apollo = write('Edit', `ssh://localhost${KEYS}`, context('apollo', [`Edit(/${KEYS})`]))
  check('Apollo Mode keeps the refusal, here as locally', apollo.behavior === 'deny' && /is a protected system or credential path\.$/.test(apollo.message ?? ''), said(apollo))
}

section('§7 the floors hold in every mode')
const fake = (name: string, kind: 'read' | 'edit') =>
  ({
    name,
    inputSchema: z.object({ file_path: z.string() }),
    isReadOnly: () => kind === 'read',
    checkPermissions: (input: { file_path: string }, ctx: { getAppState: () => { toolPermissionContext: Ctx } }) =>
      (kind === 'read' ? checkReadPermissionForTool : checkWritePermissionForTool)(tool(name), input, ctx.getAppState().toolPermissionContext),
  }) as never
const decide = async (name: string, kind: 'read' | 'edit', mode: string, path: string): Promise<Decision> => {
  const state = { toolPermissionContext: context(mode) }
  const ctx = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(fake(name, kind), { file_path: path }, ctx, { message: { id: 'ssh-path-floors' } } as never, 'ssh-path-floors')
  return outcome.decision as Decision
}
for (const mode of ['default', 'implement', 'sovereign', 'dontAsk', 'flow', 'apollo']) {
  const secret = await decide('Read', 'read', mode, `ssh://localhost${SECRET}`)
  const runtime = await decide('Write', 'edit', mode, `ssh://127.0.0.1${RUNTIME}`)
  check(`${mode}: the store is not read and the runtime is not written through a remote path`, secret.behavior === 'deny' && runtime.behavior === 'deny', `${said(secret)} · ${said(runtime)}`)
}
{
  const elsewhere = await decide('Read', 'read', 'sovereign', `ssh://web1${SECRET}`)
  check('the mode that asks nothing still reads that shape of path on another host', elsewhere.behavior === 'allow', said(elsewhere))
}

console.log(`\nssh path floors: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.chdir(launchDir)
removeScratch(scratch)
process.exit(failures === 0 ? 0 : 1)
