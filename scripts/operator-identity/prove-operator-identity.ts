#!/usr/bin/env bun
// ============================================================================
//  scripts/operator-identity/prove-operator-identity.ts — the keyed identity.
//
//  Ledger L27, brief item 10 — the pins:
//    · the key's BIRTH: first need creates <home>/identity/operator.json,
//      dir 0700 / file 0600 (posix), v1 Ed25519, 32-byte halves;
//    · BORN ONCE: a second resolve (memo cleared) re-reads the SAME key
//      byte-identically; a pre-existing file always wins a birth race;
//    · the id DERIVES FROM THE PUBLIC KEY: op- + sha256(pub)[0:12] — the
//      legacy hash generation's exact shape and length (the size-preserving
//      re-key law);
//    · NEVER IN A PROJECT: the key lands under the config home whatever the
//      cwd is; no identity/ dir appears under a project;
//    · STABLE across folders and logins: the id survives a cwd change and a
//      USER change (the display name follows the login, the id never);
//    · the ADOPTION LAW bridges BOTH legacy generations and refuses
//      foreigners;
//    · DAMAGE IS LOUD: a corrupt key file throws naming the path — never a
//      silent second identity;
//    · the mode HEALS: group/other bits are cleared on the next resolve;
//    · SIGN/VERIFY: an operator signature verifies (self and by raw public
//      key), refuses tampered bytes, refuses a foreign key's signature.
//
//  Hermetic: sweep-then-pin a scratch home BEFORE any src import.
//  Run:  ~/.bun/bin/bun run scripts/operator-identity/prove-operator-identity.ts
// ============================================================================
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

const identity = await import('../../src/substrate/identity/identity.js')
const keys = await import('../../src/substrate/identity/operatorKey.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const posix = process.platform !== 'win32'

console.log('============================================================')
console.log(' operator identity — the key born once in the config home')
console.log('============================================================')

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
section('(2) the id derives from the PUBLIC key, in the legacy shape')
{
  const path = keys.operatorKeyPath()
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { publicKey: string }
  const expected = `op-${createHash('sha256').update(Buffer.from(parsed.publicKey, 'base64url')).digest('hex').slice(0, 12)}`
  check('id === op- + sha256(raw public key)[0:12]', first.id === expected, `${first.id} vs ${expected}`)
  check('the shape matches the legacy generation exactly (op- + 12 hex — the size-preserving re-key law)', /^op-[0-9a-f]{12}$/.test(first.id))
  check('operatorPrincipal() carries the keyed id', identity.operatorPrincipal().id === first.id)
  check('…and the login as the display name', identity.operatorPrincipal().name === 'opid-tester')
  check('the keyed id is not either legacy derivation', first.id !== identity.legacyOperatorPrincipalId() && !identity.legacyOperatorPrincipalIds().includes(first.id))
}

// ---------------------------------------------------------------------------
section('(3) born once: re-resolve adopts, never re-mints')
{
  const path = keys.operatorKeyPath()
  const bytes = readFileSync(path)
  keys._resetOperatorKeyMemoForTesting()
  const again = keys.ensureOperatorKey()
  check('a fresh resolve returns the SAME id', again.id === first.id)
  check('…and the file is byte-identical (no rewrite)', readFileSync(path).equals(bytes))

  // A pre-existing file always wins a birth race: plant a handmade key in a
  // fresh home, then resolve — the planted key is adopted, not overwritten.
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
section('(5) the adoption law bridges BOTH legacy generations')
{
  const keyed = identity.operatorPrincipal().id
  const legacy = identity.legacyOperatorPrincipalId()
  check('legacy canonical recognized', identity.principalIdOwnsRecord(keyed, legacy))
  check('the keyed id owns its own records', identity.principalIdOwnsRecord(keyed, keyed))
  check('a foreign op id refused; ownerless refused', !identity.principalIdOwnsRecord(keyed, 'op-ffffffffffff') && !identity.principalIdOwnsRecord(keyed, null))
  check('a NON-operator caller gains nothing from the legacy bridge', !identity.principalIdOwnsRecord('guest-abcdef0123456789', legacy))
  check('legacy ids are re-key candidates; the keyed id is not', identity.isLegacyOperatorPrincipalId(legacy) && !identity.isLegacyOperatorPrincipalId(keyed))
}

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
section('(8) account facts attach — and no secret is reachable through them')
{
  const POISON = 'sk-ant-poison-e2e-0123456789abcdef0123456789'
  process.env.ANTHROPIC_API_KEY = POISON
  try {
    const facts = await import('../../src/substrate/identity/accountFacts.js')
    const view = await facts.operatorIdentity()
    check('the view carries the keyed principal + the public half', view.principal.id === first.id && Buffer.from(view.publicKey, 'base64url').length === 32)
    const anthropic = view.accounts.families.find(f => f.id === 'anthropic')
    check('the planted credential reads as PRESENCE for its family', anthropic !== undefined && anthropic.credentialed === true)
    const json = JSON.stringify(view)
    check('the POISON key string is unreachable through the view', !json.includes(POISON))
    check('no secret-shaped field rides the view (existence + label only)', !/"(apiKey|api_key|token|secret|credential)"\s*:/.test(json))
    check('facts are neutral data: family id · credentialed · label', view.accounts.families.every(f => typeof f.id === 'string' && typeof f.credentialed === 'boolean'))
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }
}

console.log(failures === 0 ? '\n ✅ OPERATOR IDENTITY PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
