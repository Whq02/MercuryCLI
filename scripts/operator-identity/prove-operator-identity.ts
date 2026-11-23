#!/usr/bin/env bun
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'MERCURY_SESSION_ROOM', 'MERCURY_ROOM_TOKEN', 'MERCURY_ROOM_URL']) {
  delete process.env[name]
}
const HOME = mkdtempSync(join(tmpdir(), 'opid-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.USER = 'opid-tester'

import { createHash } from 'node:crypto'

const identity = await import('../../src/platform/substrate/identity/identity.js')
const keys = await import('../../src/platform/substrate/identity/operatorKey.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}fix ensureOperatorKey, operatorKeyPath, operatorKeyId, signAsOperator or verifyOperatorSignature in src/platform/substrate/identity/operatorKey.ts, or operatorPrincipal and assistantPrincipal in src/platform/substrate/identity/identity.ts` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const posix = process.platform !== 'win32'

console.log('============================================================')
console.log(' operator identity — the key born once in the config home')
console.log('============================================================')

section('(1) birth: one 0600 file under <home>/identity, v1 Ed25519')
const first = keys.ensureOperatorKey()
{
  const path = keys.operatorKeyPath()
  check('the key file exists where declared', existsSync(path), path)
  check('…and that is under the scratch home', path.startsWith(HOME))
  if (posix) {
    check('file mode is 0600', (statSync(path).mode & 0o777) === 0o600, (statSync(path).mode & 0o777).toString(8))
    check('dir mode is 0700', (statSync(join(HOME, 'identity')).mode & 0o777) === 0o700, (statSync(join(HOME, 'identity')).mode & 0o777).toString(8))
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v: number; alg: string; publicKey: string; privateKey: string; createdAt: number }
  check('v1 Ed25519 shape', parsed.v === 1 && parsed.alg === 'Ed25519' && typeof parsed.createdAt === 'number')
  check('both halves decode to 32 bytes', Buffer.from(parsed.publicKey, 'base64url').length === 32 && Buffer.from(parsed.privateKey, 'base64url').length === 32)
}

section('(2) the id derives from the PUBLIC key')
{
  const path = keys.operatorKeyPath()
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { publicKey: string }
  const expected = `op-${createHash('sha256').update(Buffer.from(parsed.publicKey, 'base64url')).digest('hex').slice(0, 12)}`
  check('id === op- + sha256(raw public key)[0:12]', first.id === expected, `${first.id} vs ${expected}`)
  check('the id is op- + 12 hex', /^op-[0-9a-f]{12}$/.test(first.id))
  check('operatorPrincipal() carries the keyed id', identity.operatorPrincipal().id === first.id)
  check('…and the login as the display name', identity.operatorPrincipal().name === 'opid-tester')
}

section('(3) born once: re-resolve adopts, never re-mints')
{
  const path = keys.operatorKeyPath()
  const bytes = readFileSync(path)
  keys._resetOperatorKeyMemoForTesting()
  const again = keys.ensureOperatorKey()
  check('a fresh resolve returns the SAME id', again.id === first.id)
  check('…and the file is byte-identical (no rewrite)', readFileSync(path).equals(bytes))

  const home2 = mkdtempSync(join(tmpdir(), 'opid-home2-'))
  const { generateKeyPairSync } = await import('node:crypto')
  const planted = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as { x: string; d: string }
  const plantedFile = JSON.stringify({ v: 1, alg: 'Ed25519', createdAt: 7, publicKey: planted.x, privateKey: planted.d }, null, 2) + '\n'
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home2, 'identity'), { recursive: true })
  writeFileSync(join(home2, 'identity', 'operator.json'), plantedFile, { mode: 0o600 })
  process.env.MERCURY_CONFIG_DIR = home2
  keys._resetOperatorKeyMemoForTesting()
  const adopted = keys.ensureOperatorKey()
  const plantedId = `op-${createHash('sha256').update(Buffer.from(planted.x, 'base64url')).digest('hex').slice(0, 12)}`
  check('an existing key file is ADOPTED (id derives from the planted public key)', adopted.id === plantedId)
  check('…and never rewritten', readFileSync(join(home2, 'identity', 'operator.json'), 'utf8') === plantedFile)
  process.env.MERCURY_CONFIG_DIR = HOME
  keys._resetOperatorKeyMemoForTesting()
}

section('(4) never in a project; stable across folders and logins')
{
  const project = mkdtempSync(join(tmpdir(), 'opid-project-'))
  const before = process.cwd()
  try {
    process.chdir(project)
    keys._resetOperatorKeyMemoForTesting()
    const fromProject = identity.operatorPrincipal()
    check('the id is unchanged from a project cwd', fromProject.id === first.id)
    check('no identity dir appears under the project', !existsSync(join(project, 'identity')))
    process.env.USER = 'someone-else'
    const otherLogin = identity.operatorPrincipal()
    check('a login change moves the display name, never the id', otherLogin.id === first.id && otherLogin.name === 'someone-else')
  } finally {
    process.chdir(before)
    process.env.USER = 'opid-tester'
  }
}

section('(5) the keyed id is the only id')
{
  const names = Object.keys(identity).sort()
  check('the identity module answers the operator and the assistant principals and nothing else', names.join(',') === 'assistantPrincipal,operatorPrincipal', names.join(','))
}

section('(6) damage is loud; the mode heals')
{
  const home3 = mkdtempSync(join(tmpdir(), 'opid-home3-'))
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home3, 'identity'), { recursive: true })
  writeFileSync(join(home3, 'identity', 'operator.json'), 'NOT JSON AT ALL', { mode: 0o600 })
  process.env.MERCURY_CONFIG_DIR = home3
  keys._resetOperatorKeyMemoForTesting()
  let threw = ''
  try {
    keys.ensureOperatorKey()
  } catch (e) {
    threw = String(e)
  }
  check('a corrupt key file THROWS (never a silent second identity)', threw.length > 0)
  check('…naming the file and the recovery', threw.includes(join(home3, 'identity', 'operator.json')) && /restore|delete/i.test(threw))
  process.env.MERCURY_CONFIG_DIR = HOME
  keys._resetOperatorKeyMemoForTesting()

  if (posix) {
    const path = keys.operatorKeyPath()
    chmodSync(path, 0o644)
    keys._resetOperatorKeyMemoForTesting()
    keys.ensureOperatorKey()
    check('group/other bits are cleared on the next resolve (0644 → 0600)', (statSync(path).mode & 0o777) === 0o600)
  }
}

section('(7) sign / verify — authorship the key can prove')
{
  const sig = keys.signAsOperator('hello authorship')
  check('an operator signature verifies (self)', keys.verifyOperatorSignature('hello authorship', sig))
  check('…and by the advertised raw public key', keys.verifyOperatorSignature('hello authorship', sig, keys.operatorPublicKeyRaw()))
  check('tampered bytes refuse', !keys.verifyOperatorSignature('hello authorshiP', sig))
  const { generateKeyPairSync } = await import('node:crypto')
  const foreign = generateKeyPairSync('ed25519')
  const foreignRaw = Buffer.from((foreign.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  check("a foreign key's public half refuses this signature", !keys.verifyOperatorSignature('hello authorship', sig, foreignRaw))
  check('malformed key material is a refusal, never a crash', !keys.verifyOperatorSignature('x', sig, Buffer.from('too-short')))
}

if (posix) {
  section('(8) a mode that cannot be checked refuses no key; a key found to be another user\'s still does')
  const fs = await import('node:fs')
  const { mock } = await import('bun:test')
  const real = { ...fs }
  const path = keys.operatorKeyPath()
  let stand: 'through' | 'stat fails' | 'another user' = 'through'
  mock.module('node:fs', () => ({
    ...real,
    default: real,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      if (args[0] !== path || stand === 'through') return real.statSync(...args)
      if (stand === 'stat fails') throw Object.assign(new Error(`EIO: i/o error, stat '${path}'`), { code: 'EIO' })
      const stats = real.statSync(path)
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1, mode: (stats.mode & ~0o777) | 0o644 })
    },
    chmodSync: (...args: Parameters<typeof fs.chmodSync>) => {
      if (args[0] === path && stand === 'another user') throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), { code: 'EPERM' })
      return real.chmodSync(...args)
    },
  }))
  const resolve = (): string => {
    keys._resetOperatorKeyMemoForTesting()
    try { return keys.operatorKeyId() } catch (e) { return `REFUSED: ${e instanceof Error ? e.message : String(e)}` }
  }
  const own = resolve()
  stand = 'stat fails'
  const unchecked = resolve()
  stand = 'another user'
  const foreign = resolve()
  stand = 'through'
  check('the rig holds: with the stand-in passing through, the key resolves', /^[0-9a-f]+$/i.test(own) || own.length > 8, own)
  check('a key that was read and whose mode cannot be checked (EIO on its stat) is used: the same id, no refusal', unchecked === own, unchecked)
  check('control: a key found to belong to another user that cannot be made private still refuses', foreign.startsWith('REFUSED: ') && foreign.includes('belongs to another user'), foreign)
  check('…and the key resolves again afterwards', resolve() === own)
}

console.log(failures === 0 ? '\n ✅ OPERATOR IDENTITY PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
