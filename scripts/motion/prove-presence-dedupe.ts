#!/usr/bin/env bun
// ============================================================================
//  scripts/motion/prove-presence-dedupe.ts — (store half) the
//  presence tail notifies ONLY on a changed seat set.
//
//  The class: presenceLive.tailPresence() bumped its version and notified
//  React subscribers on EVERY 2s tail — with zero peers (every solo session,
//  forever) that was a standing no-change commit stream, idle or covered
//
//  The law here is the estate's output-edge dedupe (uiClock's quantized
//  bail, the frame chip's sig-dedupe): unchanged data never notifies.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hermetic membrane via RE-EXEC: bun caches os.homedir() at startup, so a
// runtime HOME mutation never reaches presenceDirPath. The outer leg spawns
// this same file with the scratch HOME in the child's env (the ambient-state
// law: the proof never touches the operator's real ~/.claude).
if (!process.env.GLIDE_PRESENCE_INNER) {
  const home = mkdtempSync(join(tmpdir(), 'glide-presence-'))
  // Pin the config-home resolution to the scratch HOME too — an ambient
  // MERCURY_CONFIG_DIR/…_HOME override would otherwise route channelsRoot()
  // outside the membrane.
  const {
    MERCURY_CONFIG_DIR: _mc,
    MERCURY_CONFIG_DIR: _cc,
    MERCURY_HOME: _mh,
    MERCURY_HOME: _hh,
    ...cleanEnv
  } = process.env
  try {
    execFileSync(process.execPath, [process.argv[1]!], {
      stdio: 'inherit',
      env: {
        ...cleanEnv,
        HOME: home,
        GLIDE_PRESENCE_INNER: '1',
        MERCURY_CHANNEL_ROOM: 'glide-dedupe-proof',
        MERCURY_OPERATOR: 'glide-self',
      },
    })
  } catch {
    process.exit(1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  process.exit(0)
}
const { getPresenceVersion, recordSelfPresence, subscribePresence, tailPresence } =
  await import('../../src/utils/cockpit/presenceLive.ts')
const { channelsRoot } = await import('../../src/services/mcp/channelsRoot.ts')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── presence output-edge dedupe ──')

let notifies = 0
subscribePresence(() => notifies++)

// 1. Zero-peer steady state: repeated tails change NOTHING and notify NOBODY.
tailPresence()
tailPresence()
tailPresence()
check('empty-room tails never bump the version', getPresenceVersion() === 0, `v=${getPresenceVersion()}`)
check('empty-room tails never notify', notifies === 0, `n=${notifies}`)

// 2. Self presence is excluded — a self-write is still a no-change tail.
recordSelfPresence({ seat: 'glide-self', verb: 'active', branch: 'main', lastLine: '' })
tailPresence()
check('a self-only room stays a no-change tail', getPresenceVersion() === 0 && notifies === 0)

// 3. A peer appearing IS a change: exactly one bump + one notify.
const dir = join(channelsRoot(), 'glide-dedupe-proof', 'presence')
mkdirSync(dir, { recursive: true })
const peer = (ts: number, verb = 'editing'): void =>
  writeFileSync(join(dir, 'friend.json'), JSON.stringify({ seat: 'friend', verb, branch: 'main', lastLine: '', ts }))
peer(Date.now())
tailPresence()
check('a new peer bumps + notifies once', getPresenceVersion() === 1 && notifies === 1, `v=${getPresenceVersion()} n=${notifies}`)

// 4. An UNCHANGED peer record is a no-change tail.
tailPresence()
tailPresence()
check('an unchanged peer never re-notifies', getPresenceVersion() === 1 && notifies === 1, `v=${getPresenceVersion()} n=${notifies}`)

// 5. The peer's heartbeat (fresh ts) IS a change — freshness is data.
peer(Date.now() + 5)
tailPresence()
check('a heartbeat ts refresh notifies', getPresenceVersion() === 2 && notifies === 2)

// 6. A stale peer dropping out IS a change (departure repaints the deck).
peer(Date.now() - 60_000)
tailPresence()
check('a stale-dropped peer notifies the departure', getPresenceVersion() === 3 && notifies === 3)
tailPresence()
check('the emptied room settles back to no-change tails', getPresenceVersion() === 3 && notifies === 3)

console.log(failures === 0 ? '✅ presence-dedupe GREEN' : `❌ presence-dedupe RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
