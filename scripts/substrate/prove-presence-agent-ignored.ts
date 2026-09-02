#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-presence-agent-ignored.ts
//  PROOF (A1 presence-producer spike, Task 4 — the structural lock):
//  presence is AGENT-IGNORED BY CONSTRUCTION, and the mirror can't drift.
//
//  THE INVARIANT this locks: a channel inbox.jsonl record becomes a MODEL TURN
//  (localChannelBus.ingestRecord wraps it → enqueue with origin {kind:'channel'}).
//  Presence MUST NEVER take that path: presenceLive writes/reads ONLY per-seat
//  snapshots under ~/.claude/channels/<room>/presence/<seat>.json and routes
//  NOTHING through the ingest queue. A future edit that quietly did so (an
//  `enqueue(`, an `ingestRecord(`, an `inbox.jsonl` write, or a `localChannelBus`
//  import) would silently turn "watch your friend work" into "your friend can
//  inject turns into your agent". This proof fails the instant that happens.
//
//  Three assertions:
//   (1) presenceLive has NO ingest path. Read the source, STRIP COMMENTS FIRST
//       (its JSDoc explains the invariant by NAMING enqueue/ingestRecord/
//       inbox.jsonl/localChannelBus — those mentions must not false-pass the
//       grep), then assert the EXECUTABLE source contains none of those tokens,
//       and DOES write only under a `presence/` path. Non-vacuity is proven both
//       ways: the RAW source DOES contain each token (so the strip has real work)
//       and the STRIPPED source does not.
//   (2) ingestRecord (localChannelBus.ts) reads ONLY inbox.jsonl, NEVER presence/.
//       The bus reads a single inbox file (openSync/readSync on
//       getLocalChannelInboxPath); it has NO `readdir` and NO `presence`
//       reference at all. If a future edit made the ingest path readdir the
//       presence dir, `presence` would appear here and this fails.
//   (3) Room-path parity (no mirror drift). presenceLive MIRRORS the bus's room
//       resolution rather than importing it (the bus is unloadable under `bun
//       run` — it pulls messageQueueManager → the feature() macro). With a known
//       MERCURY_CHANNEL_ROOM, dirname(getPresenceDir()) MUST equal the canonical
//       bus room dir ~/.claude/channels/<room>/, and presence MUST sit in a
//       `presence/` SUBDIR of it (never the room dir itself, where inbox.jsonl
//       lives). This fails if the mirrored path assembly ever diverges from the
//       ~/.claude/channels/<room>/ convention the bus also uses.
//
//  presenceLive.ts is feature()-macro-free ⇒ a LIVE import of getPresenceDir.
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-presence-agent-ignored.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import os from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Strip JS/TS line and block comments while PRESERVING string, template, and
 * regex-literal content — a string-aware scan, not a naive regex, so a future
 * edit that put `//` or `/*` inside a string literal can't accidentally hide an
 * `enqueue(` that follows it on the same line (a naive line-comment regex would).
 * Regex/division `/` (not followed by `/` or `*`) is emitted verbatim, so the
 * source's own `replace(/[^a-zA-Z0-9._-]/g, …)` regexes survive intact.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    // string / template literals — copy through to the matching close
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        const ch = src[i]
        out += ch
        if (ch === '\\') {
          // escape: copy the next char verbatim
          if (i + 1 < n) out += src[i + 1]
          i += 2
          continue
        }
        if (ch === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    // line comment
    if (c === '/' && d === '/') {
      i += 2
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // block comment (incl. JSDoc)
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2 // consume the closing */
      continue
    }
    // anything else (incl. a regex/division '/') — emit verbatim
    out += c
    i++
  }
  return out
}

console.log('============================================================')
console.log(' presence is agent-ignored by construction (never enters ingest)')
console.log('============================================================')

// ── self-test the comment stripper (so the proof itself isn't vacuous) ────────
section('(0) the comment stripper keeps code, drops comments (incl. strings/regex)')
{
  const sample =
    `const a = "http://not-a-comment" // line drop\n` +
    `/* block\n enqueue( drop */ const r = /[^a-z\\/]/g; const b = 1 // tail\n`
  const s = stripComments(sample)
  check('keeps the URL inside a string literal', s.includes('http://not-a-comment'))
  check('drops a // line comment', !s.includes('line drop'))
  check('drops a /* block */ comment (and its enqueue( mention)', !s.includes('block') && !s.includes('drop'))
  check('keeps a regex literal verbatim', s.includes('/[^a-z\\/]/g'))
  check('keeps executable code after a stripped block comment', s.includes('const r =') && s.includes('const b = 1'))
}

// ── (1) presenceLive has NO ingest path (executable source) ───────────────────
section('(1) presenceLive.ts — no enqueue / ingestRecord / inbox.jsonl / localChannelBus')
const presenceRaw = readFileSync(join(ROOT, 'src/utils/cockpit/presenceLive.ts'), 'utf8')
const presenceCode = stripComments(presenceRaw)
{
  const ingestTokens = ['enqueue', 'ingestRecord', 'inbox.jsonl', 'localChannelBus']
  // Non-vacuity, side A: the RAW source genuinely contains each token (in JSDoc),
  // so the strip is doing real work — a vacuous all-clear is impossible.
  for (const t of ingestTokens) {
    check(`RAW source mentions "${t}" (in a comment — strip has real work)`, presenceRaw.includes(t))
  }
  // Side B: the EXECUTABLE source contains none of them.
  for (const t of ingestTokens) {
    check(`stripped source has NO "${t}" (no ingest path in executable code)`, !presenceCode.includes(t))
  }
  // And presence really does write under a `presence/` path (positive control:
  // the module's writes target presence/, the assertion isn't trivially-true on
  // an empty file).
  check("executable code references the 'presence' path segment", presenceCode.includes("'presence'"))
  check('executable code writes via writeFileSync', presenceCode.includes('writeFileSync('))
  check('the only mcp import is channelAllowlist (a pure gate read, not the bus)', presenceCode.includes("channelAllowlist.js") && !presenceCode.includes('messageQueueManager'))
}

// ── (2) ingestRecord reads ONLY inbox.jsonl, never the presence/ dir ──────────
section('(2) localChannelBus.ts — ingest reads inbox.jsonl; never readdir/reads presence/')
const busRaw = readFileSync(join(ROOT, 'src/services/mcp/localChannelBus.ts'), 'utf8')
const busCode = stripComments(busRaw)
{
  // The bus IS the ingest path: ingestRecord → enqueue, and the tailer reads the
  // single inbox file. Positive controls (would fail if the bus stopped being the
  // ingest path we're fencing presence away from):
  check('ingestRecord exists (the path presence must never reach)', /function ingestRecord\b/.test(busCode))
  check('ingestRecord routes to enqueue (= a model turn)', busCode.includes('enqueue('))
  check("the bus reads the 'inbox.jsonl' file", busCode.includes("'inbox.jsonl'"))
  check('the bus reads that single inbox file (openSync/readSync)', busCode.includes('openSync(') && busCode.includes('readSync('))
  // The lock: the ingest path NEVER touches presence — no readdir, no `presence`.
  check('the bus does NOT readdir any dir (single-file inbox read, not a seat sweep)', !busCode.includes('readdir'))
  check('the bus has NO "presence" reference (ingest never reads the presence/ dir)', !busCode.includes('presence'))
}

// ── (3) room-path parity — the mirror can't drift from ~/.claude/channels/<room>/ ─
section('(3) parity — dirname(getPresenceDir()) === the canonical bus room dir')
{
  // presenceLive resolves the room at CALL time from MERCURY_CHANNEL_ROOM, and an
  // explicit room makes presence active regardless of fork/build — so a live
  // import + getPresenceDir() round-trip is enough.
  const { getPresenceDir } = await import('../../src/utils/cockpit/presenceLive.js')

  // Scratch-home names (only [a-zA-Z0-9._-]) pass the sanitizer as identity, so the
  // expected path is the bus's documented canonical convention verbatim.
  for (const room of ['team-room', 'a1.presence_spike', 'roomZ']) {
    process.env.MERCURY_CHANNEL_ROOM = room
    const dir = getPresenceDir()
    check(`room="${room}" ⇒ getPresenceDir() is active (non-null)`, dir !== null, String(dir))
    if (!dir) continue
    // the canonical room dir the LOCAL BUS also uses (getRoomDir =
    // join(channelsRoot(), <room>)) — channelsRoot.ts is the tiny shared owner
    // both modules import (loadable under `bun run`, unlike the bus module),
    // so the parity law is asserted against the OWNER, not a restated path.
    const { channelsRoot } = await import('../../src/services/mcp/channelsRoot.js')
    const canonicalRoomDir = join(channelsRoot(), room)
    check(`  dirname(presenceDir) === channelsRoot()/${room}`, dirname(dir) === canonicalRoomDir, dirname(dir))
    // structural separation: presence lives in a `presence/` SUBDIR of the room,
    // NEVER the room dir itself (where inbox.jsonl — the ingest file — lives).
    check('  presence is a `presence/` SUBDIR of the room dir', basename(dir) === 'presence')
    check('  presenceDir !== the room dir (separate from inbox.jsonl)', dir !== canonicalRoomDir)
    check('  presenceDir === join(roomDir, "presence")', dir === join(canonicalRoomDir, 'presence'))
  }
  delete process.env.MERCURY_CHANNEL_ROOM
}

console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ presence is agent-ignored by construction — no ingest path, mirror in parity')
else console.log(`❌ ${fail} PRESENCE-AGENT-IGNORED PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
