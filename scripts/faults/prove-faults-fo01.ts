#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

const home = process.env.MERCURY_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'faults-fo01-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_AUTH_SCOPE_DIR = home
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
const daemonHome = join(home, 'daemon')
mkdirSync(daemonHome, { recursive: true })
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

console.log('collision evidence: an unreadable file is not written over')
if (!POSIX_MODES) skip('collision evidence kept', 'no file modes here')
else {
  const { recordCollisionEvidence, concourseCollisionsPath } = await import('../../src/daemon/concourse-workers/collisions.js')
  const dir = mkdtempSync(join(tmpdir(), 'faults-fo01-coll-'))
  const path = concourseCollisionsPath(dir)
  const before = `${JSON.stringify({ version: 1, rows: [{ schema: 1, kind: 'exclusive-overlap', workspaceId: '/w', holders: [], observedAt: 1 }] })}\n`
  writeFileSync(path, before)
  chmodSync(path, 0o000)
  let threw: unknown
  try {
    recordCollisionEvidence({ schema: 1, kind: 'exclusive-overlap', workspaceId: '/v', holders: [], observedAt: 2 }, dir)
  } catch (error) {
    threw = error
  }
  chmodSync(path, 0o600)
  check('an unreadable collision file keeps its rows after a record call', readFileSync(path, 'utf8') === before, `${readFileSync(path, 'utf8').slice(0, 120)} ${threw} — recordCollisionEvidence in src/daemon/concourse-workers/collisions.ts must not rewrite a collisions file it could not read`)
}

console.log('git-init asks: an unreadable sidecar is not written over')
if (!POSIX_MODES) skip('git-init sidecar kept', 'no file modes here')
else {
  const { mintGitInitAsk } = await import('../../src/daemon/session-seat/permissionAsks.js')
  const sidecar = join(daemonHome, 'git-init-asks.json')
  const before = JSON.stringify({ 'git-init:aaaaaaaaaaaa': '/kept/folder' })
  writeFileSync(sidecar, before)
  chmodSync(sidecar, 0o000)
  const folder = mkdtempSync(join(home, 'plain-'))
  const minted = mintGitInitAsk(folder)
  chmodSync(sidecar, 0o600)
  if ('refused' in minted) skip('git-init sidecar kept', `the folder was refused: ${minted.refused.words}`)
  else check('an unreadable git-init sidecar keeps its asks after a mint', readFileSync(sidecar, 'utf8') === before, `${readFileSync(sidecar, 'utf8').slice(0, 120)} — mintGitInitAsk in src/daemon/session-seat/permissionAsks.ts must not write over a sidecar it could not read`)
}

console.log('control key: a key that cannot be read is not taken for absent')
if (!POSIX_MODES) skip('control key unreadable', 'no file modes here')
else {
  const cs = await import('../../src/daemon/control/controlSocket.js')
  const keyPath = cs.controlKeyPath()
  writeFileSync(keyPath, 'live-key', { mode: 0o600 })
  check('a readable key is read', (await cs.readLiveControlKey()) === 'live-key', 'readLiveControlKey in src/daemon/control/controlSocket.ts must return the key stored at controlKeyPath()')
  chmodSync(keyPath, 0o000)
  let threw: unknown
  let got: unknown = 'none'
  try {
    got = await cs.readLiveControlKey()
  } catch (error) {
    threw = error
  }
  chmodSync(keyPath, 0o600)
  check('an unreadable key is an error, not "no key"', (threw as NodeJS.ErrnoException | undefined)?.code === 'EACCES', `got ${String(got)} — readLiveControlKey in src/daemon/control/controlSocket.ts must rethrow EACCES, not return null`)
  check('the unreadable key file is left as it was', readFileSync(keyPath, 'utf8') === 'live-key', 'readLiveControlKey in src/daemon/control/controlSocket.ts must not delete or rewrite a key file it could not read')
  const { unlinkSync } = await import('node:fs')
  unlinkSync(keyPath)
  check('an absent key reads as null', (await cs.readLiveControlKey()) === null, 'readLiveControlKey in src/daemon/control/controlSocket.ts must return null when the key file does not exist')
}

console.log('fresh sign-in restart: a failed ask is asked again')
{
  const ownedMod = await import('../../src/daemon/control/ownedDaemon.js')
  const { clearOAuthTokenCache } = await import('../../src/models/sign-in/lifecycle/oauthLifecycle.js')
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: '[redacted]', refreshToken: '[redacted]', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
    { mode: 0o600 },
  )
  clearOAuthTokenCache()
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ envKeptAuthAtSpawn: true, spawnLabel: 'daemon' })
  let asks = 0
  const failing = async (): Promise<unknown> => {
    asks++
    throw new Error('ECONNREFUSED')
  }
  const answering = async (): Promise<unknown> => {
    asks++
    return { ok: true, op: 'restart-when-idle', state: 'armed', live: 1 }
  }
  const first = await ownedMod.restartOwnedDaemonForFreshSignin({ rpc: failing })
  const second = await ownedMod.restartOwnedDaemonForFreshSignin({ rpc: answering })
  check('the ask that failed is made again on the next landing', asks === 2 && second === 'asked', `first ${first} second ${second} asks ${asks} — restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must not mark a failed ask as made`)
  const third = await ownedMod.restartOwnedDaemonForFreshSignin({ rpc: answering })
  check('an ask that was answered is not made again', third === 'not-applicable' && asks === 2, `third ${third} asks ${asks} — restartOwnedDaemonForFreshSignin in src/daemon/control/ownedDaemon.ts must mark an answered ask as made`)
  ownedMod.__resetOwnedDaemonFreshSigninForTest({ spawnLabel: null })
}

console.log('build hold: a manifest that cannot be opened is not "no manifest"')
if (!POSIX_MODES) skip('build hold unreadable', 'no file modes here')
else {
  const { holdBuild } = await import('../../src/daemon/control/daemonBuild.js')
  const absentDir = mkdtempSync(join(tmpdir(), 'faults-fo01-build-'))
  check('a build folder with no manifest answers no-manifest', holdBuild(absentDir) === 'no-manifest', 'holdBuild in src/daemon/control/daemonBuild.ts must answer no-manifest for a folder without manifest.json')
  const lockedDir = mkdtempSync(join(tmpdir(), 'faults-fo01-build-'))
  writeFileSync(join(lockedDir, 'manifest.json'), '{}')
  chmodSync(join(lockedDir, 'manifest.json'), 0o000)
  const answer = holdBuild(lockedDir)
  chmodSync(join(lockedDir, 'manifest.json'), 0o600)
  check('a manifest that cannot be opened answers unheld with its code', typeof answer === 'object' && answer.unheld === 'EACCES', `${JSON.stringify(answer)} — holdBuild in src/daemon/control/daemonBuild.ts must answer { unheld: code } for a manifest it cannot open, not no-manifest`)
}

console.log(failures === 0 ? '\nall rows green' : `\n${failures} row(s) red`)
process.exit(failures === 0 ? 0 : 1)
