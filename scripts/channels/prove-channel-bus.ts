#!/usr/bin/env bun
// ============================================================================
//  scripts/channels/prove-channel-bus.ts
//  PROOF (complete-substrate): the LOCAL channel bus (the agents' wire; the /say door retired typed) — the
//  inbound chatroom transport that had ZERO proof coverage while every other
//  substrate domain auto-joins the green-gate.
//
//   (a) isLocalChannelBusEnabled() gate matrix: MERCURY_LOCAL_CHANNELS hard
//       override (0 off / 1 on) and the default (stamped-build && channels-on).
//       OFF ⇒ the whole bus is a no-op (byte-identical to the default).
//   (b) getLocalChannelRoom() SANITIZE FIX (bug/med): a MERCURY_CHANNEL_ROOM
//       override can never carry a path separator or '..' into the inbox path
//       — the same sanitizer that already guarded the cwd-basename fallback now
//       also runs on the override, AND a pure-dot result ('.', '..') is neutralized
//       (the bare-regex alone leaves '..' intact since '.' is in the allow-class).
//   (c) postLocalChannelMessage → JSONL append: the SEND half writes ONE
//       well-formed JSON record per line; JSON.stringify escapes newlines/tabs/
//       quotes so a multi-line body can never break the one-record-per-line
//       invariant the tail relies on. Proven END-TO-END through the built dist
//       (the one place feature()/bun:bundle is resolved) via a real headless turn (now: the retired door's typed answer + zero writes).
//   (d) drainFrom offset/carry on partial lines + truncation-restart: the tail's
//       split/carry/offset algorithm and the size<offset rotation guard (locked
//       structurally — the module imports the feature() macro graph bun-run can't
//       transform, same as the snapshot-contract proof; the retired-door leg in (c)
//       exercises the real append→record path through dist).
//   (e) the RENDER leg: UserTextMessage dispatches `<channel source="` user text
//       to UserChannelMessage (the `← server · user: body` transcript row). This
//       wire was SEVERED for Mercury's whole life — the arm sat behind
//       the OLD scheduler/channel feature gates, false in every build, so
//       bus + MCP channel pushes rendered as raw XML. Re-landed as a static
//       Mercury-owned dispatch; the dist needle (the component's regex literal)
//       fails if the import is ever tree-shaken out again.
//
//  The bus module pulls messageQueueManager → bun:bundle feature() (a build-only
//  macro bun-run rejects even with a stub) + color-diff-napi, so it is imported
//  STRUCTURALLY here and exercised LIVE through dist; the loadable leaf modules
//  (channelAllowlist, channelNotification) are driven directly. See
//  memory/bun-run-proof-loadability + scripts/substrate/prove-snapshot-contract.ts.
//
//  Run:  ~/.bun/bin/bun run scripts/channels/prove-channel-bus.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')
function withEnv<T>(key: string, v: string | undefined, fn: () => T): T {
  const prev = process.env[key]
  if (v === undefined) delete process.env[key]
  else process.env[key] = v
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

console.log('============================================================')
console.log(' Local channel bus — the agent wire (the /say door retired typed)')
console.log('============================================================')

// ── (a) gate matrix — driven LIVE via the loadable leaf (channelAllowlist) ──
// isLocalChannelBusEnabled lives in the feature()-tainted bus module, but it is a
// thin AND of two readable predicates: the MERCURY_LOCAL_CHANNELS override and
// isChannelsEnabled(). channelAllowlist loads fine; we drive
// isChannelsEnabled() directly (the override semantics it owns are identical) +
// structurally lock the bus enable to that same predicate.
section('(a) isLocalChannelBusEnabled gate matrix (OFF ⇒ byte-identical)')
const allow = (await import(
  '../../src/services/mcp/channelAllowlist.js'
)) as typeof import('../../src/services/mcp/channelAllowlist.js')
check(
  'MERCURY_CHANNELS=0 hard-disables (mirrors MERCURY_LOCAL_CHANNELS=0)',
  withEnv('MERCURY_CHANNELS', '0', () => allow.isChannelsEnabled() === false),
)
check(
  'MERCURY_CHANNELS=1 force-enables even off a stamped build',
  withEnv('MERCURY_CHANNELS', '1', () => allow.isChannelsEnabled() === true),
)
check(
  'stamped-build default ⇒ enabled (MACRO stamped)',
  withEnv('MERCURY_CHANNELS', undefined, () => allow.isChannelsEnabled() === true),
)
const bus = src('services', 'mcp', 'localChannelBus.ts')
check(
  'isLocalChannelBusEnabled gates on MERCURY_LOCAL_CHANNELS + isChannelsEnabled() ',
  /flagEnv\('MERCURY_LOCAL_CHANNELS'\)/.test(bus) &&
    /return isChannelsEnabled\(\)/.test(bus),
)
check(
  'startLocalChannelBus returns a dead no-op handle when disabled (no tail, no file)',
  /if \(!isLocalChannelBusEnabled\(\)\) return dead/.test(bus),
)

// ── (b) getLocalChannelRoom sanitize FIX (bug/med) ──────────────────────────
// The exact sanitizer the source now applies to BOTH branches, replicated so we
// can assert the traversal-neutralizing property on adversarial inputs.
section('(b) getLocalChannelRoom — override sanitize fix (no path-escape)')
const SAN = /return\s+sanitizeRoom\(override\)/
check(
  'the override branch now runs the sanitizer (not the raw trim)',
  SAN.test(bus),
)
check(
  'a single sanitizeRoom() helper is the source of truth (cwd + override both use it)',
  /function sanitizeRoom\(/.test(bus) &&
    (bus.match(/sanitizeRoom\(/g) || []).length >= 3,
)
check(
  'sanitizer strips path separators / non-[a-zA-Z0-9._-] to "_"',
  /replace\(\/\[\^a-zA-Z0-9\._-\]\/g,\s*['"]_['"]\)/.test(bus),
)
check(
  'sanitizer neutralizes a pure-dot segment so a literal ".." cannot escape upward',
  /\.\./.test(bus) && /\bdefault\b/.test(bus),
)
// Behavioural mirror of the shipped sanitizer (regex + dot-segment guard).
const sanitize = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return /^\.+$/.test(cleaned) ? 'default' : cleaned || 'default'
}
check(
  '"../../etc/evil" ⇒ ONE safe segment: no "/" separator and not a pure-dot traversal',
  !sanitize('../../etc/evil').includes('/') &&
    !/^\.+$/.test(sanitize('../../etc/evil')),
  sanitize('../../etc/evil'),
)
check('".." ⇒ neutralized to a safe segment', sanitize('..') === 'default')
check('"." ⇒ neutralized', sanitize('.') === 'default')
check('"a/b" ⇒ "a_b" (separator collapsed)', sanitize('a/b') === 'a_b')
check('"ok-room.1" ⇒ unchanged (legit names survive)', sanitize('ok-room.1') === 'ok-room.1')
check('"" ⇒ "default"', sanitize('') === 'default')
check(
  'getRoomDir join can never receive a separator/".." segment ⇒ stays under channelsRoot()',
  /join\(channelsRoot\(\),\s*getLocalChannelRoom\(\)\)/.test(bus),
)
// The root itself is the shared owner: ONE native rendezvous under the
// config home. There is no legacy continuity read —
// pinned so a compat rung cannot quietly return.
const rootSrc = src('services', 'mcp', 'channelsRoot.ts')
check(
  'channelsRoot is the one native root (legacy continuity read retired)',
  /join\(getMercuryHome\(\),\s*['"]channels['"]\)/.test(rootSrc) &&
    !/\.claude/.test(rootSrc.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '')),
)

// ── (b2) getLocalChannelRoom PATH-HASH FIX ─────────
// The bare cwd-basename fallback was a cross-session prompt-injection vector: two
// unrelated dirs sharing a basename ('api','src','app',…) mapped to ONE inbox, so
// a line in one project's room was ingested as a <channel> message by a session in
// the other. The fallback now folds an 8-hex hash of the ABSOLUTE cwd into the
// name, so distinct dirs get distinct rooms while same-dir sessions still co-join.
section('(b2) getLocalChannelRoom — abs-path hash fallback (no basename collision)')
check(
  'the fallback hashes the absolute cwd (createHash + resolve) into the room name',
  /createHash\(['"]sha256['"]\)/.test(bus) &&
    /\.digest\(['"]hex['"]\)\.slice\(0,\s*8\)/.test(bus) &&
    /resolve\(getOriginalCwd\(\)\s*\|\|\s*process\.cwd\(\)\)/.test(bus),
)
check(
  'the override branch is still verbatim-sanitized (intentional shared room unaffected)',
  /if \(override\) return sanitizeRoom\(override\)/.test(bus),
)
check(
  'the room dir is created owner-only (0700) — not world/group readable',
  /mkdirSync\(dir,\s*\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}\)/.test(bus),
)
// Behavioural mirror of the shipped fallback (sanitize(basename)+'-'+hash8(abs)).
const roomOf = (cwd: string): string => {
  const c = resolve(cwd)
  const base = sanitize(basename(c) || 'default')
  return `${base}-${createHash('sha256').update(c).digest('hex').slice(0, 8)}`
}
const rA = roomOf('/work/acme/api')
const rB = roomOf('/personal/side/api')
check(
  'two unrelated dirs sharing basename "api" map to DISTINCT rooms',
  rA !== rB,
  `${rA} != ${rB}`,
)
check('the room name still carries the readable basename prefix', rA.startsWith('api-') && rB.startsWith('api-'))
check(
  'same absolute cwd ⇒ same room (same-project sessions still auto-join)',
  roomOf('/work/acme/api') === roomOf('/work/acme/api/.') &&
    roomOf('/work/acme/api') === roomOf('/work/acme/api/'),
)
check('the hashed room is still ONE safe segment (no path separator)', !rA.includes('/') && /^[a-zA-Z0-9._-]+$/.test(rA))

// ── (c) postLocalChannelMessage → JSONL append (the agents' wire) ───────────
// Operator ruling: the /say DOOR retired typed; the WIRE stays.
// postLocalChannelMessage keeps zero in-product callers by design — it is the
// programmatic send API the agents reach; the ingest/tail/render legs below
// are the live side. The old live round-trip drove the door; its successor
// pins the door's typed answer + the door writing NOTHING.
section('(c) postLocalChannelMessage → JSONL append (the wire; the retired door answers typed)')
// JSONL one-record-per-line integrity: JSON.stringify escapes the body so a
// multi-line / tab / quote payload cannot smuggle a second line onto the bus.
const rec = { server: 'op', content: 'line1\nline2\twith\ttabs "and quotes"' }
const wireLine = JSON.stringify(rec) + '\n'
const partsAfterSplit = wireLine.split('\n')
check(
  'a newline in the body does NOT add a bus line (JSON.stringify escapes it)',
  partsAfterSplit.length === 2 && partsAfterSplit[1] === '',
)
check(
  'the escaped record round-trips back to the original',
  JSON.stringify(JSON.parse(partsAfterSplit[0])) === JSON.stringify(rec),
)
check(
  'postLocalChannelMessage appends `${JSON.stringify(record)}\\n` and never throws (returns false)',
  /appendFileSync\(\s*getLocalChannelInboxPath\(\),\s*`\$\{JSON\.stringify\(record\)\}\\n`/.test(bus) &&
    /return false/.test(bus),
)
// END-TO-END: a real headless `/say` turn through the built product must now
// answer the TYPED retirement and land NO record at the room inbox (the door
// is inert; the wire is reached programmatically). Skips gracefully (still
// PASS) if no dist build is present.
const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs absent — run `bun run build.ts` for the retired-door leg')
} else {
  const home = mkdtempSync(join(tmpdir(), 'hermes-chan-'))
  try {
    // Pin the config-home resolution to the scratch HOME (proof hygiene):
    // an ambient MERCURY_CONFIG_DIR/…_HOME would route channelsRoot() outside
    // the membrane. A fresh scratch home resolves the sovereign ~/.mercury,
    // so the channels root lands at <home>/.mercury/channels.
    const {
      MERCURY_CONFIG_DIR: _mc,
      MERCURY_CONFIG_DIR: _cc,
      MERCURY_HOME: _mh,
      ...cleanEnv
    } = process.env
    // spawnSync, never execFileSync: the capture must survive ANY exit code —
    // a throwing runner turned a wrong ANSWER into a crashed PROOF (the
    // every-turn-outage bug hid behind exactly that shape, caught live).
    const r = spawnSync(
      (process.execPath.includes('bun') ? 'node' : process.execPath),
      [distPath, '-p', '/say hello-from-proof'],
      {
        env: {
          ...cleanEnv,
          HOME: home,
          MERCURY_LOCAL_CHANNELS: '1',
          MERCURY_CHANNEL_ROOM: 'proofroom',
          MERCURY_OPERATOR: 'proofbot',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    )
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    // /say typed is retired (operator-ruled; the wire stays for the
    // agents), so the -p turn is a REFUSAL now — and a refusal's honest
    // shape is the landed F2 contract: sentence + exit 1, never an
    // execution-error envelope. The next check pins the sentence itself.
    check(
      'the -p turn refuses with the honest rc (typed sentence + exit 1, no error envelope)',
      r.status === 1 && !/error_during_execution/.test(out),
      `status=${r.status} ${out.slice(0, 160)}`,
    )
    check(
      'the retired /say door answers its typed reason (never unknown-command)',
      /The \/say command is retired — a new multiplayer is being built on the channel/.test(out),
      out.slice(0, 200),
    )
    const inbox = join(home, '.mercury', 'channels', 'proofroom', 'inbox.jsonl')
    const lines = existsSync(inbox)
      ? readFileSync(inbox, 'utf-8').split('\n').filter(Boolean)
      : []
    check('the retired door writes NOTHING to the room inbox', lines.length === 0, `${lines.length} line(s)`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── (d) drainFrom offset/carry + truncation-restart (structural) ────────────
section('(d) drainFrom — offset/carry on partial lines + truncation-restart')
check(
  'reads only the NEW bytes (size - offset) and advances offset by what it read',
  /size - offset/.test(bus) && /offset \+= read/.test(bus),
)
check(
  'carries the (possibly partial) trailing line between reads (lines.pop)',
  /carry = lines\.pop\(\) \?\? ['"]['"]/.test(bus) && /carry \+ buf\.toString/.test(bus),
)
check(
  'truncation/rotation guard: size < offset ⇒ restart from the top (offset=0, carry cleared)',
  /if \(size < offset\)/.test(bus) && /offset = 0/.test(bus) && /carry = ['"]['"]/.test(bus),
)
check(
  'malformed JSON line is skipped (logged), not fatal — the tail keeps draining',
  /skipping malformed line/.test(bus),
)
check(
  'a fresh session starts at EOF (no history replay) unless opts.replayHistory',
  /opts\.replayHistory \? 0 : statSync\(path\)\.size/.test(bus),
)
check(
  'polling fallback (1s, unref) backs up fs.watch for missed appends on network/edited files',
  /setInterval\(drainFrom, 1000\)/.test(bus) && /poll\.unref/.test(bus),
)

// ── /say — the RETIRED door ────────────────────
section('/say — the retired door: one stub owner, no direct registration, no body')
const retiredCmds = src('commands', 'retired.ts')
check(
  "the retired-stub module owns the 'say' name (typed answer, hidden, -p capable)",
  /\{ name: 'say',/.test(retiredCmds),
)
const cmds = src('commands.ts')
check(
  'no direct /say registration remains in commands.ts',
  !/import say from '\.\/commands\/say\/index\.js'/.test(cmds) && !/^\s*say,\s*$/m.test(cmds),
)
check(
  'the old command body is gone from the tree',
  !existsSync(join(ROOT, 'src', 'commands', 'say', 'index.ts')),
)

// ── (e) the render leg: dispatch arm + component, source + dist ─────────────
section('(e) render leg — UserTextMessage → UserChannelMessage (severed-wire relanding)')
const userText = src('components', 'messages', 'UserTextMessage.tsx')
check(
  'UserTextMessage dispatches `<channel source="` text to UserChannelMessage',
  /param\.text\.includes\(`<\$\{CHANNEL_TAG\} source="`\)/.test(userText) &&
    /<UserChannelMessage addMargin=\{addMargin\} param=\{param\} \/>/.test(userText),
)
check(
  'the dispatch import is STATIC (no feature()/require() gate left around it)',
  /import \{ UserChannelMessage \} from '\.\/UserChannelMessage\.js'/.test(userText) &&
    !/feature\(/.test(userText),
)
const chanMsg = src('components', 'messages', 'UserChannelMessage.tsx')
check(
  'UserChannelMessage renders the ← arrow + dim `server · user:` prefix',
  /CHANNEL_ARROW/.test(chanMsg) && /displayServerName/.test(chanMsg) && /dimColor/.test(chanMsg),
)
// Dist needle: USER_ATTR_RE's regex literal is unique to the component and
// survives minification verbatim — present ⇔ the component is bundled (i.e.
// the dispatch import is alive). Skips gracefully when dist is absent, same
// as (c); under the pooled gate Phase 0 prebuilds dist so this always runs.
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs absent — run `bun run build.ts` for the dist needle')
} else {
  const dist = readFileSync(distPath, 'utf-8')
  check(
    'dist carries UserChannelMessage (regex-literal needle `user="([^"]+)"`)',
    dist.includes('user="([^"]+)"'),
  )
}

// ── auto-joins the green-gate (the missing-coverage fix) ────────────────────
section('auto-joins scripts/run-all-suites.sh (glob of scripts/*/run-all.sh)')
const runner = join(import.meta.dir, 'run-all.sh')
check('scripts/channels/run-all.sh exists ⇒ the suite auto-joins the gate', existsSync(runner))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CHANNEL-BUS PROOFS PASS')
else console.log(`❌ ${failures} CHANNEL-BUS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
