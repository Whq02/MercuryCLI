#!/usr/bin/env bun

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

function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        const ch = src[i]
        out += ch
        if (ch === '\\') {
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
    if (c === '/' && d === '/') {
      i += 2
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

console.log('============================================================')
console.log(' presence is agent-ignored by construction (never enters ingest)')
console.log('============================================================')

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

section('(1) presenceLive.ts — no enqueue / ingestRecord / inbox.jsonl / localChannelBus')
const presenceRaw = readFileSync(join(ROOT, 'src/utils/cockpit/presenceLive.ts'), 'utf8')
const presenceCode = stripComments(presenceRaw)
{
  const ingestTokens = ['enqueue', 'ingestRecord', 'inbox.jsonl', 'localChannelBus']
  for (const t of ingestTokens) {
    check(`stripped source has NO "${t}" (no ingest path in executable code)`, !presenceCode.includes(t))
  }
  check("executable code references the 'presence' path segment", presenceCode.includes("'presence'"))
  check('executable code writes via writeFileSync', presenceCode.includes('writeFileSync('))
  check('the only mcp import is channelAllowlist (a pure gate read, not the bus)', presenceCode.includes("channelAllowlist.js") && !presenceCode.includes('messageQueueManager'))
}

section('(2) localChannelBus.ts — ingest reads inbox.jsonl; never readdir/reads presence/')
const busRaw = readFileSync(join(ROOT, 'src/services/mcp/localChannelBus.ts'), 'utf8')
const busCode = stripComments(busRaw)
{
  check('ingestRecord exists (the path presence must never reach)', /function ingestRecord\b/.test(busCode))
  check('ingestRecord routes to enqueue (= a model turn)', busCode.includes('enqueue('))
  check("the bus reads the 'inbox.jsonl' file", busCode.includes("'inbox.jsonl'"))
  check('the bus reads that single inbox file (openSync/readSync)', busCode.includes('openSync(') && busCode.includes('readSync('))
  check('the bus does NOT readdir any dir (single-file inbox read, not a seat sweep)', !busCode.includes('readdir'))
  check('the bus has NO "presence" reference (ingest never reads the presence/ dir)', !busCode.includes('presence'))
}

section('(3) parity — dirname(getPresenceDir()) === the canonical bus room dir')
{
  const { getPresenceDir } = await import('../../src/utils/cockpit/presenceLive.js')

  for (const room of ['team-room', 'a1.presence_spike', 'roomZ']) {
    process.env.MERCURY_CHANNEL_ROOM = room
    const dir = getPresenceDir()
    check(`room="${room}" ⇒ getPresenceDir() is active (non-null)`, dir !== null, String(dir))
    if (!dir) continue
    const { channelsRoot } = await import('../../src/services/mcp/channelsRoot.js')
    const canonicalRoomDir = join(channelsRoot(), room)
    check(`  dirname(presenceDir) === channelsRoot()/${room}`, dirname(dir) === canonicalRoomDir, dirname(dir))
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
