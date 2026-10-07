import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as hs from '../../src/daemon/handshake.js'
import { MERCURY_DAEMON_PROTO } from '../../src/daemon/protocol.js'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const client = { proto: MERCURY_DAEMON_PROTO, version: '1.0.0-beta.28', buildTree: 'bbbbbbbbbbbb' }
const reply = { ok: true as const, op: 'hello' as const, proto: MERCURY_DAEMON_PROTO, minProto: 1, ready: true,
  version: client.version, buildTree: 'aaaaaaaaaaaa', pid: 42, startedAt: 1, ownerPid: null,
  foreground: false, live: 1, liveSessions: 1, warm: 0, restartArmed: false }
const installed = { version: client.version, buildTree: reply.buildTree }
check('an installed tree does not establish chronology', !hs.screenIsOlder(reply, client, installed))
const unknown = hs.decideHandshake({kind: 'hello', reply}, client, 100, installed)
const words = `${unknown.line ?? ''} ${hs.daemonHandshakeEvidence(unknown)}`
check('equal version builds say the order is unknown', words.includes('build order unknown') && !words.includes('older build') && !words.includes('newer Mercury'), words)
check('unknown chronology does not automatically replace a running build', unknown.heal === 'operator', unknown.heal)
const newer = hs.decideHandshake({kind: 'hello', reply: {...reply, version: '1.0.0-beta.29'}}, client, 100, installed)
check('a provably newer version still tells the older screen to reopen', newer.heal === 'reopen', newer.heal)
const older = hs.decideHandshake({kind: 'hello', reply: {...reply, version: '1.0.0-beta.27'}}, client, 100, installed)
check('a provably older version may restart when idle', older.heal === 'restart-when-idle', older.heal)
const statusWords = (hs as unknown as { daemonBuildStatusWords?: (v: hs.DaemonHandshakeVerdict | null) => string }).daemonBuildStatusWords
check('the row names the daemon build instead of hiding behind ready', statusWords?.(unknown) === 'daemon build aaaaaaaaaaaa differs', statusWords?.(unknown))
const matched = hs.decideHandshake({kind: 'hello', reply: {...reply, buildTree: client.buildTree}}, client)
check('matching builds owe no mismatch clause', statusWords?.(matched) === '' && statusWords?.(null) === '')
const row = readFileSync(join(import.meta.dir, '../../src/components/SwitchboardTagBar.tsx'), 'utf8')
check('the real status row subscribes to the handshake and keeps the mismatch in its fixed head', row.includes('useSyncExternalStore(subscribeDaemonHandshake, focusedDaemonBuildWords, focusedDaemonBuildWords)') && row.includes('[daemonBuild, modelStatusWords(shownModel, shownEffort)]') && row.includes("daemonBuild === '' && held === null && line === 'ready'"))
console.log(`prove-build-order-visible: ${failed ? `${failed} RED` : 'GREEN'}`)
process.exit(failed ? 1 : 0)
