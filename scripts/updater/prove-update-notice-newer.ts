#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'update-notice-newer-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0-beta.17' }

const {
  decideFaceNotice,
  decideQuietCheck,
  readUpdateNoticeCache,
  runQuietUpdateCheck,
  updateNoticeCachePath,
  updateNoticeText,
  UPDATE_NOTICE_DAILY_MS,
  writeUpdateNoticeCache,
} = await import('../../src/services/privateChannel/quietUpdateNotice.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const BASE_READS = 'the base tree answers the other way'

const RUNNING = '1.0.0-beta.17'
const OLDER = '1.0.0-beta.16'
const NEWER = '1.0.0-beta.18'
const NOW = 1_700_000_000_000
type Cache = NonNullable<ReturnType<typeof readUpdateNoticeCache>>
const cached = (available: string | undefined, running = RUNNING, checkedAtMs = NOW - 60_000, faceAnnounced?: string): Cache => ({
  schema: 1,
  checkedAtMs,
  runningVersion: running,
  ...(available !== undefined ? { available: { version: available, tag: `v${available}` } } : {}),
  ...(faceAnnounced !== undefined ? { faceAnnounced } : {}),
})

console.log('============================================================')
console.log(' the quiet update notice offers only a version newer than the one running, on every road')
console.log('============================================================')

section('§1 the cache road: a cached answer is offered only when it is newer than the running build')
{
  const older = decideQuietCheck(cached(OLDER), NOW, RUNNING)
  check(`a cached ${OLDER} under a running ${RUNNING} is skipped, never offered (${BASE_READS}: notify-from-cache)`, older.action === 'skip', JSON.stringify(older))
  const equal = decideQuietCheck(cached(RUNNING), NOW, RUNNING)
  check('a cached version equal to the running one is skipped', equal.action === 'skip', JSON.stringify(equal))
  const newer = decideQuietCheck(cached(NEWER), NOW, RUNNING)
  check(`a cached ${NEWER} is offered from the cache (the control)`, newer.action === 'notify-from-cache' && newer.available.version === NEWER, JSON.stringify(newer))
  const counter = decideQuietCheck(cached('1.0.0-beta.9', '1.0.0-beta.10'), NOW, '1.0.0-beta.10')
  check(`the prerelease counter compares as a number: a cached beta.9 under a running beta.10 is skipped (${BASE_READS}: any difference notifies)`, counter.action === 'skip', JSON.stringify(counter))
  const bigger = decideQuietCheck(cached('1.0.0-beta.10', '1.0.0-beta.9'), NOW, '1.0.0-beta.9')
  check('…and a cached beta.10 under a running beta.9 is offered', bigger.action === 'notify-from-cache', JSON.stringify(bigger))
  check('a cache written by another running version is never read: the boot checks again', decideQuietCheck(cached(NEWER, OLDER), NOW, RUNNING).action === 'check')
  check('a cache older than a day checks again', decideQuietCheck(cached(NEWER, RUNNING, NOW - UPDATE_NOTICE_DAILY_MS - 1), NOW, RUNNING).action === 'check')
  check('no cache checks', decideQuietCheck(null, NOW, RUNNING).action === 'check')
}

section('§2 the check road: a listing that names a version at or below the running build says nothing and records a current cache')
{
  const cachePath = updateNoticeCachePath(home)
  const notices: string[] = []
  let listings = 0
  const outcomeFor = (version: string) => ({ state: 'update-available', installed: OLDER, tag: `v${version}`, version, assetName: 'x', channelRepo: 'r', road: 'anonymous', assetUrl: null, checksumUrl: null })
  const deps = (outcome: unknown, now: number, running = RUNNING) => ({
    check: async () => {
      listings++
      return outcome as never
    },
    readCache: () => readUpdateNoticeCache(cachePath),
    writeCache: (cache: Parameters<typeof writeUpdateNoticeCache>[0]) => writeUpdateNoticeCache(cache, cachePath),
    notify: (text: string) => notices.push(text),
    now: () => now,
    runningVersion: running,
  })

  rmSync(cachePath, { force: true })
  const olderResult = await runQuietUpdateCheck(deps(outcomeFor(OLDER), NOW))
  check(`a listing whose newest release (${OLDER}) is below the running ${RUNNING} is not notified: the result is the current word (${BASE_READS}: notified)`, olderResult === 'current', olderResult)
  check(`…no line is painted (${BASE_READS}: the ${OLDER} line)`, notices.length === 0, JSON.stringify(notices))
  const afterOlder = readUpdateNoticeCache(cachePath)
  check(`…the cache is written as current for the running version (${BASE_READS}: the older version is cached as available)`, afterOlder !== null && afterOlder.runningVersion === RUNNING && afterOlder.available === undefined && afterOlder.checkedAtMs === NOW, JSON.stringify(afterOlder))
  const sameDay = await runQuietUpdateCheck(deps(outcomeFor(OLDER), NOW + 3_600_000))
  check(`a same-day boot after it skips without a listing (${BASE_READS}: notified from the cache)`, sameDay === 'skipped' && listings === 1 && notices.length === 0, `${sameDay} listings=${listings} notices=${JSON.stringify(notices)}`)

  rmSync(cachePath, { force: true })
  const equalResult = await runQuietUpdateCheck(deps(outcomeFor(RUNNING), NOW))
  check(`a listing whose newest release equals the running version is not notified (${BASE_READS}: notified)`, equalResult === 'current' && notices.length === 0, `${equalResult} notices=${JSON.stringify(notices)}`)

  rmSync(cachePath, { force: true })
  const newerResult = await runQuietUpdateCheck(deps(outcomeFor(NEWER), NOW))
  check(`a listing whose newest release is ${NEWER} is notified with the one calm line (the control)`, newerResult === 'notified' && notices.length === 1 && notices[0] === updateNoticeText(NEWER), `${newerResult} notices=${JSON.stringify(notices)}`)
  const afterNewer = readUpdateNoticeCache(cachePath)
  check('…and the cache records the newer version as available', afterNewer?.available?.version === NEWER && afterNewer.runningVersion === RUNNING, JSON.stringify(afterNewer))
  const fromCache = await runQuietUpdateCheck(deps(outcomeFor(NEWER), NOW + 3_600_000))
  check('…a same-day boot offers it again from the cache, with no listing', fromCache === 'notified-from-cache' && notices.length === 2, `${fromCache} notices=${notices.length}`)

  rmSync(cachePath, { force: true })
  writeUpdateNoticeCache({ schema: 1, checkedAtMs: NOW - UPDATE_NOTICE_DAILY_MS - 1, runningVersion: RUNNING, faceAnnounced: NEWER }, cachePath)
  await runQuietUpdateCheck(deps(outcomeFor(OLDER), NOW))
  check('the face announcement already recorded rides along on the current cache the check road writes', readUpdateNoticeCache(cachePath)?.faceAnnounced === NEWER, JSON.stringify(readUpdateNoticeCache(cachePath)))

  rmSync(cachePath, { force: true })
  const current = await runQuietUpdateCheck(deps({ state: 'current', installed: RUNNING, channelRepo: 'r', road: 'anonymous' }, NOW))
  check('a current listing still answers the current word and caches', current === 'current' && readUpdateNoticeCache(cachePath)?.available === undefined)
}

section('§3 the face road already compared: it stays as it is')
{
  check('an older cached version paints no face line', decideFaceNotice(cached(OLDER), RUNNING) === null)
  check('an equal cached version paints no face line', decideFaceNotice(cached(RUNNING), RUNNING) === null)
  check('a newer cached version paints it once', decideFaceNotice(cached(NEWER), RUNNING) === NEWER)
  check('…and not again once announced', decideFaceNotice(cached(NEWER, RUNNING, NOW - 60_000, NEWER), RUNNING) === null)
}

section('§4 a version that does not parse keeps the any-difference reading on both roads')
{
  const dev = decideQuietCheck(cached(NEWER, 'dev'), NOW, 'dev')
  check('the cache road under a running version outside the channel grammar offers any different version', dev.action === 'notify-from-cache', JSON.stringify(dev))
  const unparsed = decideQuietCheck(cached('nightly'), NOW, RUNNING)
  check('the cache road with a cached version outside the grammar offers it as a difference', unparsed.action === 'notify-from-cache', JSON.stringify(unparsed))
  const cachePath = updateNoticeCachePath(join(home, 'dev'))
  const notices: string[] = []
  const result = await runQuietUpdateCheck({
    check: async () => ({ state: 'update-available', installed: 'dev', tag: `v${OLDER}`, version: OLDER, assetName: 'x', channelRepo: 'r', road: 'anonymous', assetUrl: null, checksumUrl: null }) as never,
    readCache: () => readUpdateNoticeCache(cachePath),
    writeCache: cache => writeUpdateNoticeCache(cache, cachePath),
    notify: text => notices.push(text),
    now: () => NOW,
    runningVersion: 'dev',
  })
  check('the check road under a running version outside the grammar notifies any different version', result === 'notified' && notices[0] === updateNoticeText(OLDER), `${result} ${JSON.stringify(notices)}`)
  check('the face road reads the same fallback', decideFaceNotice(cached(OLDER, 'dev'), 'dev') === OLDER)
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
