#!/usr/bin/env bun
// ============================================================================
//  scripts/channel/prove-channel-primitives.ts
//  PROOF: the connection primitive holds its invariants in its own
//  home (src/services/channel) — the frame envelope's seal/CRC/decode
//  classes, the hybrid clock's order, frame signing, and the sealed link's
//  confidentiality vectors. The room/transport journeys live in their own
//  suites; this file pins the primitive alone.
//
//  Pure leg: the four modules read no env and touch no fs — the scratch pin
//  below is defensive only (ambient-state law).
//
//  Run:  ~/.bun/bin/bun run scripts/channel/prove-channel-primitives.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'MERCURY_SESSION_ROOM', 'MERCURY_ROOM_TOKEN', 'MERCURY_ROOM_URL']) {
  delete process.env[name]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'channel-proof-home-'))

import {
  crc32Hex,
  sealFrame,
  encodeFrameLine,
  decodeFrameLine,
  canonicalFrameJson,
  type FrameDraft,
} from '../../src/services/channel/frame.js'
import {
  createHlcState,
  hlcTick,
  hlcObserve,
  decodeHlc,
  compareHlc,
  principalNode,
} from '../../src/services/channel/hlc.js'
import {
  OPERATOR_SIG_PREFIX,
  authenticatedBytes,
  isOperatorSignedFrame,
  mintSharedSecret,
  signFrame,
  signFrameAsOperator,
  verifyFrameSig,
  verifyOperatorFrameSig,
} from '../../src/services/channel/signing.js'
import {
  buildAuth,
  deriveInviteHint,
  deriveSealedKeys,
  isLoopbackHost,
  mintHandshakeNonce,
  openAuthBox,
  SealedLink,
  SealedLinkError,
} from '../../src/services/channel/sealedChannel.js'
import type { Principal } from '../../src/substrate/identity/principal.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const OP: Principal = { id: 'op-abc', kind: 'operator', name: 'sam' }

function draft(kind: string, body: unknown, author: Principal = OP): FrameDraft {
  return { room: 'r1', author, kind: kind as FrameDraft['kind'], body }
}

console.log('============================================================')
console.log(' channel — the connection primitive in its own home')
console.log('============================================================')

// ---------------------------------------------------------------------------
section('(1) frame seal + CRC + canonical round-trip')
{
  const f = sealFrame(draft('chat.human', { text: 'hello' }), { seq: 1, hlc: 'x' })
  check('seq/hlc stamped', f.seq === 1 && f.hlc === 'x')
  check('id minted', typeof f.id === 'string' && f.id.length > 0)
  check('crc present + 8 hex', /^[0-9a-f]{8}$/.test(f.c))
  const line = encodeFrameLine(f)
  check('line ends with newline', line.endsWith('\n'))
  check('line has no interior newline', line.slice(0, -1).indexOf('\n') === -1)
  const decoded = decodeFrameLine(line.trimEnd())
  check('decodes ok', decoded.ok === true)
  if (decoded.ok) {
    check('round-trips identically', JSON.stringify(decoded.frame) === JSON.stringify(f))
  }
  // The spliced-c encode path must match a canonical recompute exactly.
  const { c, ...rest } = f
  check('encoded bytes-minus-c === canonicalFrameJson(rest)', line.trimEnd() === canonicalFrameJson(rest).slice(0, -1) + `,"c":"${c}"}`)
}

// ---------------------------------------------------------------------------
section('(2) decode failure classes are distinguished (torn / crc / invalid)')
{
  check('partial JSON ⇒ torn', decodeFrameLine('{"v":1,"room":"r1"').ok === false && (decodeFrameLine('{"v":1,"room":"r1"') as { failure?: string }).failure === 'torn')
  const f = sealFrame(draft('chat.human', { text: 'x' }), { seq: 1, hlc: 'x' })
  const tampered = { ...f, body: { text: 'TAMPERED' } }
  const tline = canonicalFrameJson(tampered).slice(0, -1) + `,"c":"${f.c}"}`
  const td = decodeFrameLine(tline)
  check('tampered body ⇒ crc-mismatch', td.ok === false && (td as { failure?: string }).failure === 'crc-mismatch')
  const missingAuthor = JSON.stringify({ v: 1, room: 'r1', seq: 1, hlc: 'x', id: 'i', kind: 'chat.human', body: {}, c: 'deadbeef' })
  const md = decodeFrameLine(missingAuthor)
  check('missing author ⇒ invalid-envelope', md.ok === false && (md as { failure?: string }).failure === 'invalid-envelope')
  // Forward-compat: a SHAPE-VALID unknown kind decodes (consumers default-
  // ignore; the room ACL fail-closes) — only a MALFORMED kind is invalid.
  const futureKind = sealFrame(draft('chat.human', { text: 'x' }), { seq: 1, hlc: 'x' })
  const futureKindLine = (() => {
    const shaped = { ...futureKind, kind: 'poll.vote' as never }
    const { c: _c, ...rest } = shaped
    return canonicalFrameJson(rest).slice(0, -1) + `,"c":"${crc32Hex(canonicalFrameJson(rest))}"}`
  })()
  check('unknown-but-shaped kind decodes (forward-compat)', decodeFrameLine(futureKindLine).ok === true)
  const badKind = JSON.stringify({ v: 1, room: 'r1', seq: 1, hlc: 'x', id: 'i', author: OP, kind: 'NOT A KIND', body: {}, c: 'deadbeef' })
  check('malformed kind ⇒ invalid-envelope', (decodeFrameLine(badKind) as { failure?: string }).failure === 'invalid-envelope')
  const futureV = JSON.stringify({ v: 99, room: 'r1', seq: 1, hlc: 'x', id: 'i', author: OP, kind: 'chat.human', body: {}, c: 'x' })
  check('future version ⇒ invalid-envelope (v > FRAME_VERSION rejected)', (decodeFrameLine(futureV) as { failure?: string }).failure === 'invalid-envelope')
  check('crc32 is deterministic', crc32Hex('abc') === crc32Hex('abc') && crc32Hex('abc') !== crc32Hex('abd'))
}

// ---------------------------------------------------------------------------
section('(3) HLC total order under adversarial clocks')
{
  const a = createHlcState('nodeA', 1000)
  const stamps: string[] = []
  for (let i = 0; i < 5; i++) stamps.push(hlcTick(a, 1000))
  check('same-ms burst strictly increasing', stamps.every((s, i) => i === 0 || compareHlc(stamps[i - 1]!, s) < 0))
  const back = hlcTick(a, 500)
  check('backwards wall clock still advances', compareHlc(stamps[stamps.length - 1]!, back) < 0)
  const b = createHlcState('nodeB', 1000)
  const future = hlcTick(b, 9_999_999)
  hlcObserve(a, future, 1000)
  const afterObserve = hlcTick(a, 1000)
  check('local tick after observing a future peer sorts after it', compareHlc(future, afterObserve) < 0)
  const d = decodeHlc(afterObserve)
  check('hlc decodes', d !== null && d.node === 'nodeA')
  check('unparseable peer stamp does not wedge the clock', (() => { const s = createHlcState('n', 1); hlcObserve(s, 'garbage', 1); return hlcTick(s, 1) !== '' })())
  check('principalNode strips dots + caps length (HLC field safety)', principalNode('op-a.b.c') === 'op-abc' && principalNode('x'.repeat(40)).length === 24 && principalNode('') === 'node')
}

// ---------------------------------------------------------------------------
section('(4) frame signing — HMAC under a shared secret')
{
  const secret = mintSharedSecret()
  const f = sealFrame(draft('chat.human', { text: 'remote' }), { seq: 1, hlc: 'x' })
  const sig = signFrame(f, secret)
  const signed = sealFrame({ ...draft('chat.human', { text: 'remote' }), sig }, { seq: 1, hlc: 'x', id: f.id })
  check('valid sig verifies', verifyFrameSig(signed, secret))
  check('wrong secret rejected', !verifyFrameSig(signed, mintSharedSecret()))
  check('unsigned frame rejected by verify', !verifyFrameSig(f, secret))
  const tampered = sealFrame({ ...draft('chat.human', { text: 'EVIL' }), sig }, { seq: 1, hlc: 'x', id: f.id })
  check('tampered signed body rejected', !verifyFrameSig(tampered, secret))
  // The signed bytes are the canonical envelope MINUS sig and MINUS c — the
  // CRC and the signature can never disagree about what was signed.
  check('authenticatedBytes strips sig + c only', authenticatedBytes(signed) === canonicalFrameJson((({ c: _c, sig: _s, ...rest }) => rest)(signed) as never))
}

// ---------------------------------------------------------------------------
section('(4b) operator authorship — the keyed signature on local frames')
{
  const identity = await import('../../src/substrate/identity/identity.js')
  const keyMod = await import('../../src/substrate/identity/operatorKey.js')
  const me = identity.operatorPrincipal()
  const f = sealFrame(draft('turn.user', { text: 'mine' }, me), { seq: 1, hlc: 'x' })
  const authorship = signFrameAsOperator(f)
  check('the keyed author gets a tagged authorship signature', authorship !== null && authorship.startsWith(OPERATOR_SIG_PREFIX))
  const signed = sealFrame({ ...draft('turn.user', { text: 'mine' }, me), sig: authorship! }, { seq: 1, hlc: 'x', id: f.id })
  check('the signed frame is recognized as operator-signed', isOperatorSignedFrame(signed))
  check('it verifies against the advertised public key', verifyOperatorFrameSig(signed, keyMod.operatorPublicKeyRaw()))
  const tampered = sealFrame({ ...draft('turn.user', { text: 'MINE' }, me), sig: authorship! }, { seq: 1, hlc: 'x', id: f.id })
  check('a tampered body refuses', !verifyOperatorFrameSig(tampered, keyMod.operatorPublicKeyRaw()))
  const { generateKeyPairSync } = await import('node:crypto')
  const foreignRaw = Buffer.from((generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  check("a foreign operator's key refuses", !verifyOperatorFrameSig(signed, foreignRaw))
  // Never a false claim, never a gate: an author that is not this key's id
  // signs NOTHING — the caller appends unsigned instead of failing.
  const other = sealFrame(draft('chat.human', { text: 'x' }, OP), { seq: 1, hlc: 'x' })
  check("someone else's frame yields null (unsigned, never a false claim)", signFrameAsOperator(other) === null)
  // The two signers never confuse a verifier.
  const secret = mintSharedSecret()
  const hmacSigned = sealFrame({ ...draft('chat.human', { text: 'r' }, OP), sig: signFrame(f, secret) }, { seq: 1, hlc: 'x', id: f.id })
  check('an HMAC-signed frame is not operator-signed', !isOperatorSignedFrame(hmacSigned) && !verifyOperatorFrameSig(hmacSigned, keyMod.operatorPublicKeyRaw()))
  check('an operator-signed frame refuses the HMAC verifier', !verifyFrameSig(signed, secret))
}

// ---------------------------------------------------------------------------
section('(5) the sealed link — the invite token never crosses the wire')
{
  const token = 'proof-token-abcdefghijklmnop'
  const hint = deriveInviteHint(token)
  check('hint is stable', hint === deriveInviteHint(token))
  check('hint is 16 hex chars', /^[0-9a-f]{16}$/.test(hint))
  check('hint is NOT a token substring (nothing of the token rides the wire)', !token.includes(hint))
  check('different tokens ⇒ different hints', hint !== deriveInviteHint(token + 'x'))

  const nS = mintHandshakeNonce()
  const nC = mintHandshakeNonce()
  const keys = deriveSealedKeys(token, nS, nC)
  check('keys are 32B each and direction-distinct', keys.c2s.length === 32 && keys.s2c.length === 32 && !keys.c2s.equals(keys.s2c))
  const keys2 = deriveSealedKeys(token, nS, nC)
  check('same inputs ⇒ same keys (both sides derive independently)', keys.c2s.equals(keys2.c2s) && keys.s2c.equals(keys2.s2c))
  const keys3 = deriveSealedKeys(token, mintHandshakeNonce(), nC)
  check('fresh nonce ⇒ fresh keys (per-connection sessions)', !keys.c2s.equals(keys3.c2s))

  const client = new SealedLink(keys, 'client')
  const server = new SealedLink(keys, 'server')
  const c2s = client.seal({ hello: 'from client', n: 42 })
  const got = server.open(c2s)
  check('c2s roundtrip', JSON.stringify(got) === JSON.stringify({ hello: 'from client', n: 42 }))
  const s2c = server.seal({ type: 'welcome', v: 3 })
  const got2 = client.open(s2c)
  check('s2c roundtrip', (got2 as { type?: string }).type === 'welcome')
  check('client seal counter starts at 1 (0 = the auth box)', c2s.n === 1)

  const boxT = client.seal({ secret: 'payload' })
  const raw = Buffer.from(boxT.ct, 'base64')
  raw[0] = raw[0]! ^ 0xff
  let tampered = ''
  try {
    server.open({ ...boxT, ct: raw.toString('base64') })
  } catch (e) {
    tampered = e instanceof SealedLinkError ? e.reason : 'other'
  }
  check('tampered box ⇒ SealedLinkError(tamper)', tampered === 'tamper')
  const gotT = server.open(boxT)
  check('honest box still opens after a tamper attempt (window not wedged)', (gotT as { secret?: string }).secret === 'payload')

  let replayed = ''
  try {
    server.open(boxT)
  } catch (e) {
    replayed = e instanceof SealedLinkError ? e.reason : 'other'
  }
  check('replayed box ⇒ SealedLinkError(replay)', replayed === 'replay')

  const b1 = client.seal({ i: 1 })
  const b2 = client.seal({ i: 2 })
  server.open(b2)
  let reordered = ''
  try {
    server.open(b1)
  } catch (e) {
    reordered = e instanceof SealedLinkError ? e.reason : 'other'
  }
  check('reordered (stale) box ⇒ SealedLinkError(replay)', reordered === 'replay')

  client.seal({ skipped: true }) // sealed but never delivered
  const b4 = client.seal({ i: 4 })
  const got4 = server.open(b4)
  check('counter gap tolerated (send-side skip ≠ attack)', (got4 as { i?: number }).i === 4)

  const payload = { nonceS: nS.toString('base64'), name: 'user1' }
  const auth = buildAuth(token, keys, nC, payload)
  check('auth message carries hint + nonce + box', auth.hint === hint && auth.nonce === nC.toString('base64') && auth.box.length > 0)
  const wrongKeys = deriveSealedKeys('a-different-invite-token', nS, nC)
  check('wrong candidate keys open NOTHING (try-verify primitive)', openAuthBox(wrongKeys, auth.box) === null)
  const opened = openAuthBox(keys, auth.box)
  check('right candidate keys open the auth payload', opened !== null && opened.nonceS === nS.toString('base64') && opened.name === 'user1')

  check('127.0.0.1 loopback', isLoopbackHost('127.0.0.1'))
  check('localhost loopback', isLoopbackHost('localhost'))
  check('::1 loopback (incl. bracketed)', isLoopbackHost('::1') && isLoopbackHost('[::1]'))
  check('127.0.0.53 loopback (whole /8)', isLoopbackHost('127.0.0.53'))
  check('::ffff:127.0.0.1 loopback (v4-mapped)', isLoopbackHost('::ffff:127.0.0.1'))
  check('0.0.0.0 NOT loopback', !isLoopbackHost('0.0.0.0'))
  check('LAN ip NOT loopback', !isLoopbackHost('192.168.1.20'))
  check('hostname NOT loopback', !isLoopbackHost('example.com'))
  check('1270.0.0.1 NOT loopback (no prefix trick)', !isLoopbackHost('1270.0.0.1'))
}

// ---------------------------------------------------------------------------
section('(6) neutrality — no room/party vocabulary in the primitive homes')
{
  // The API the successor multiplayer builds on carries no estate vocabulary. The
  // Frame envelope's `room` FIELD is the one deliberate exception: it is the
  // on-disk/wire field name (renaming it re-keys every stored CRC), kept
  // byte-identical at the extraction and named here so its survival is a
  // decision, not drift.
  const { readFileSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const ROOT = j(import.meta.dir, '..', '..')
  for (const rel of ['src/services/channel/sealedChannel.ts', 'src/services/channel/hlc.ts', 'src/services/channel/signing.ts']) {
    const src = readFileSync(j(ROOT, rel), 'utf8')
    const exported = [...src.matchAll(/export (?:function|class|const|interface|type) ([A-Za-z0-9_]+)/g)].map(m => m[1]!)
    check(`${rel}: no party/room export names`, exported.every(n => !/room|party/i.test(n)), exported.filter(n => /room|party/i.test(n)).join(','))
  }
}

console.log(failures === 0 ? '\n ✅ CHANNEL PRIMITIVES PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
