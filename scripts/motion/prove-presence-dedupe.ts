#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.GLIDE_PRESENCE_INNER) {
  const home = mkdtempSync(join(tmpdir(), 'glide-presence-'))
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

tailPresence()
tailPresence()
tailPresence()
check('empty-room tails never bump the version', getPresenceVersion() === 0, `v=${getPresenceVersion()}`)
check('empty-room tails never notify', notifies === 0, `n=${notifies}`)

recordSelfPresence({ seat: 'glide-self', verb: 'active', branch: 'main', lastLine: '' })
tailPresence()
check('a self-only room stays a no-change tail', getPresenceVersion() === 0 && notifies === 0)

const dir = join(channelsRoot(), 'glide-dedupe-proof', 'presence')
mkdirSync(dir, { recursive: true })
const peer = (ts: number, verb = 'editing'): void =>
  writeFileSync(join(dir, 'friend.json'), JSON.stringify({ seat: 'friend', verb, branch: 'main', lastLine: '', ts }))
peer(Date.now())
tailPresence()
check('a new peer bumps + notifies once', getPresenceVersion() === 1 && notifies === 1, `v=${getPresenceVersion()} n=${notifies}`)

tailPresence()
tailPresence()
check('an unchanged peer never re-notifies', getPresenceVersion() === 1 && notifies === 1, `v=${getPresenceVersion()} n=${notifies}`)

peer(Date.now() + 5)
tailPresence()
check('a heartbeat ts refresh notifies', getPresenceVersion() === 2 && notifies === 2)

peer(Date.now() - 60_000)
tailPresence()
check('a stale-dropped peer notifies the departure', getPresenceVersion() === 3 && notifies === 3)
tailPresence()
check('the emptied room settles back to no-change tails', getPresenceVersion() === 3 && notifies === 3)

console.log(failures === 0 ? '✅ presence-dedupe GREEN' : `❌ presence-dedupe RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
