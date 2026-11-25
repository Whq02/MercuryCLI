#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROOF_EXCHANGE_DEADLINE_MS, proofRoad, readRow, told, writeRow, type ProofPair } from './lib/locked-refresh-road.ts'
import { rotatingTokenServer } from './lib/rotating-token-server.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { lockedRefresh } = await import('../../src/models/sign-in/lifecycle/lockedRefresh.ts')

const fixHint = 'fix lockedRefresh in src/models/sign-in/lifecycle/lockedRefresh.ts; the stand-in token server is scripts/provauth/lib/rotating-token-server.ts and the road this proof hands the door is scripts/provauth/lib/locked-refresh-road.ts'
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} — ${fixHint}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(what: string, holds: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what} — ${fixHint}`)
    await sleep(20)
  }
}

const server = rotatingTokenServer('rt-0')
const store = join(proofHome, '.locked-refresh-proof.json')
const unwritable = `${store}.unwritable`
const lockDir = `${store}.lock`
const PROOF_STALE_MS = PROOF_EXCHANGE_DEADLINE_MS + 2_000
const EMAIL = 'row@example.invalid'
const seed = (refreshToken: string): void => writeRow(store, { email: EMAIL, tokens: { accessToken: `at-of-${refreshToken}`, refreshToken, expiresAtMs: Date.now() - 1_000 } })
const stored = (): ProofPair | undefined => readRow(store)?.tokens
const liveToken = (): string => server.live ?? 'the grant is revoked'

type ChildEnd = { before?: string; answer: { state: string; refreshToken?: string; error?: string }; stored?: string }
function child(onAbout: () => void): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'locked-refresh-child.ts'), store, server.base], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => {
      out += String(chunk)
      if (out.includes('"about":"refresh"')) onAbout()
    })
    proc.stderr.on('data', chunk => { err += String(chunk) })
    const overdue = setTimeout(() => proc.kill('SIGKILL'), 30_000)
    proc.on('close', code => {
      clearTimeout(overdue)
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '') as ChildEnd)
      } catch {
        reject(new Error(`the child ended rc=${code}: ${out.slice(-400)} ${err.slice(-400)}`))
      }
    })
  })
}

try {
  console.log('── two processes, one credential: one exchange reaches the server and both end with the live pair ──')
  seed('rt-0')
  let release = server.hold()
  const first = child(() => {})
  await until('the first process has its grant at the server', () => server.grants.length === 1)
  let secondIsWaiting = false
  const second = child(() => { secondIsWaiting = true })
  await until('the second process has read the pair and asked to refresh it', () => secondIsWaiting)
  await sleep(400)
  check('while the first process exchanges, its lock stands beside the store and the second sends nothing', existsSync(`${store}.lock`) && server.grants.length === 1, `${server.grants.length} grants`)
  release()
  const [a, b] = await Promise.all([first, second])
  check('both processes read the same pair before they refreshed', a.before === 'rt-0' && b.before === 'rt-0', JSON.stringify([a, b]))
  check('exactly one exchange reached the server', server.grants.length === 1 && server.grants[0]?.refreshToken === 'rt-0', JSON.stringify(server.grants.map(g => g.refreshToken)))
  check('the first exchanged and the second took the pair the first wrote', a.answer.state === 'refreshed' && a.answer.refreshToken === 'rt-1' && b.answer.state === 'current' && b.answer.refreshToken === 'rt-1', JSON.stringify([a.answer, b.answer]))
  check('the store holds the one live pair and the server did not revoke the grant', stored()?.refreshToken === 'rt-1' && server.live === 'rt-1', `stored ${stored()?.refreshToken}, live ${server.live}`)
  check('the lock is gone when both are done', !existsSync(`${store}.lock`))

  console.log('── one process: a fresh pair is left alone, calls at once are joined, a second instance on the file waits ──')
  const mine = lockedRefresh<ProofPair>()
  let before = server.grants.length
  const left = await mine(proofRoad(store, server.base))
  check('a fresh pair is answered as it stands with nothing sent', left.state === 'current' && left.pair.refreshToken === 'rt-1' && server.grants.length === before, JSON.stringify(told(left)))
  const [x, y] = await Promise.all([mine(proofRoad(store, server.base, true)), mine(proofRoad(store, server.base, true))])
  check('two forced calls at once are one exchange and one answer', server.grants.length === before + 1 && x === y && x.state === 'refreshed' && x.pair.refreshToken === 'rt-2', `${server.grants.length - before} grants, ${JSON.stringify(told(x))}`)
  const other = lockedRefresh<ProofPair>()
  before = server.grants.length
  release = server.hold()
  const holding = mine(proofRoad(store, server.base, true))
  await until('the first instance has its grant at the server', () => server.grants.length === before + 1)
  const waiting = other(proofRoad(store, server.base, true))
  await sleep(300)
  check('a second instance on the same file sends nothing while the first holds the lock', server.grants.length === before + 1)
  release()
  const [held, adopted] = await Promise.all([holding, waiting])
  check('it then takes the pair the first wrote instead of exchanging again', server.grants.length === before + 1 && held.state === 'refreshed' && adopted.state === 'current' && adopted.pair.refreshToken === 'rt-3' && stored()?.refreshToken === 'rt-3', JSON.stringify([told(held), told(adopted)]))

  console.log('── a dead grant blanks the refresh token and keeps the row; it is never sent again ──')
  seed('rt-unknown')
  before = server.grants.length
  const dead = await mine(proofRoad(store, server.base))
  check('invalid_grant is answered as dead', dead.state === 'dead' && told(dead).error === 'HTTP 400 invalid_grant' && server.grants.length === before + 1, JSON.stringify(told(dead)))
  check('the row keeps its identity and its access token, with the refresh token blank', readRow(store)?.email === EMAIL && stored()?.accessToken === 'at-of-rt-unknown' && stored()?.refreshToken === '', JSON.stringify(readRow(store)))
  const afterDead = await mine(proofRoad(store, server.base))
  check('the next call sends nothing', afterDead.state === 'absent' && server.grants.length === before + 1, JSON.stringify(told(afterDead)))
  seed('rt-unknown-2')
  writeFileSync(unwritable, '')
  before = server.grants.length
  const deadUnwritten = await mine(proofRoad(store, server.base))
  const deadAgain = await mine(proofRoad(store, server.base))
  check('a dead grant that could not be blanked on disk is still sent once only', deadUnwritten.state === 'dead' && deadAgain.state === 'dead' && server.grants.length === before + 1 && stored()?.refreshToken === 'rt-unknown-2', JSON.stringify([told(deadUnwritten), told(deadAgain), server.grants.length - before]))
  rmSync(unwritable)

  console.log('── a passing failure changes nothing on disk ──')
  seed(liveToken())
  const bytes = readFileSync(store, 'utf8')
  server.status = 503
  const failed = await mine(proofRoad(store, server.base))
  check('a 503 is answered as failed with the road\'s own error', failed.state === 'failed' && told(failed).error === 'the stand-in token server answered HTTP 503', JSON.stringify(told(failed)))
  server.status = 200
  const unreachable = await mine(proofRoad(store, 'http://127.0.0.1:1'))
  check('a server that cannot be reached is answered as failed', unreachable.state === 'failed', JSON.stringify(told(unreachable)))
  check('the store is byte for byte what it was and no lock is left', readFileSync(store, 'utf8') === bytes && !existsSync(`${store}.lock`))
  const recovered = await mine(proofRoad(store, server.base))
  check('the next call exchanges the same pair', recovered.state === 'refreshed' && stored()?.refreshToken === server.live, JSON.stringify(told(recovered)))

  console.log('── a new pair that could not be written is not lost to this process ──')
  seed(liveToken())
  const spent = liveToken()
  writeFileSync(unwritable, '')
  const unsaved = await mine(proofRoad(store, server.base))
  const kept = liveToken()
  check('the call answers the new pair though the store still holds the spent one', unsaved.state === 'refreshed' && unsaved.pair.refreshToken === kept && kept !== spent && stored()?.refreshToken === spent, JSON.stringify({ answer: told(unsaved), stored: stored()?.refreshToken, live: kept }))
  before = server.grants.length
  const stillKept = await mine(proofRoad(store, server.base))
  check('the next call answers the kept pair and sends nothing', stillKept.state === 'current' && stillKept.pair.refreshToken === kept && server.grants.length === before, JSON.stringify(told(stillKept)))
  const forcedKept = await mine(proofRoad(store, server.base, true))
  check('a forced call exchanges the kept pair, never the spent one on disk', forcedKept.state === 'refreshed' && server.grants.at(-1)?.refreshToken === kept && server.live !== undefined && forcedKept.pair.refreshToken === server.live, JSON.stringify({ sent: server.grants.at(-1)?.refreshToken, live: server.live }))
  rmSync(unwritable)
  before = server.grants.length
  const landed = await mine(proofRoad(store, server.base))
  check('once the store can be written the next ordinary call lands the kept pair in it, with nothing sent', landed.state === 'current' && server.live !== undefined && landed.pair.refreshToken === server.live && stored()?.refreshToken === server.live && server.grants.length === before, JSON.stringify({ answer: told(landed), stored: stored()?.refreshToken, live: server.live, grants: server.grants.length - before }))
  const afterLanding = await other(proofRoad(store, server.base, true))
  check('so another reader of the store exchanges the live token, never the spent one', afterLanding.state === 'refreshed' && server.live !== undefined && stored()?.refreshToken === server.live, JSON.stringify({ answer: told(afterLanding), live: server.live }))

  console.log('── the store changed while the exchange was out: nothing is written over it ──')
  seed(liveToken())
  before = server.grants.length
  release = server.hold()
  const signedOutMeanwhile = mine(proofRoad(store, server.base))
  await until('the grant is at the server', () => server.grants.length === before + 1)
  writeRow(store, { email: EMAIL })
  release()
  const signedOut = await signedOutMeanwhile
  check('a sign-out during the exchange stays a sign-out', signedOut.state === 'absent' && readRow(store)?.tokens === undefined, JSON.stringify({ answer: told(signedOut), row: readRow(store) }))
  seed(liveToken())
  before = server.grants.length
  release = server.hold()
  const signedInMeanwhile = mine(proofRoad(store, server.base))
  await until('the grant is at the server', () => server.grants.length === before + 1)
  writeRow(store, { email: 'other@example.invalid', tokens: { accessToken: 'at-of-a-new-sign-in', refreshToken: 'rt-of-a-new-sign-in', expiresAtMs: Date.now() + 3_600_000 } })
  release()
  const signedIn = await signedInMeanwhile
  check('a new sign-in during the exchange is what stands and what is answered', signedIn.state === 'current' && signedIn.pair.refreshToken === 'rt-of-a-new-sign-in' && readRow(store)?.email === 'other@example.invalid' && stored()?.refreshToken === 'rt-of-a-new-sign-in', JSON.stringify({ answer: told(signedIn), row: readRow(store)?.email }))
  seed(liveToken())
  before = server.grants.length
  release = server.hold()
  const failedMeanwhile = mine(proofRoad(store, server.base))
  await until('the grant is at the server', () => server.grants.length === before + 1)
  writeRow(store, { email: EMAIL, tokens: { accessToken: 'at-of-another-writer', refreshToken: 'rt-of-another-writer', expiresAtMs: Date.now() + 3_600_000 } })
  server.status = 503
  release()
  const failedButChanged = await failedMeanwhile
  server.status = 200
  check('an exchange that fails while another writer stores a pair answers the pair that stands', failedButChanged.state === 'current' && failedButChanged.pair.refreshToken === 'rt-of-another-writer' && stored()?.refreshToken === 'rt-of-another-writer', JSON.stringify(told(failedButChanged)))

  console.log('── a holder that held its lock past the stale time does not remove its successor\'s ──')
  seed(liveToken())
  before = server.grants.length
  const releaseHolder = server.hold()
  const displaced = child(() => {})
  await until('the holder has its grant at the server', () => server.grants.length === before + 1)
  const heldSince = Date.now()
  const releaseSuccessor = server.hold()
  const successor = mine(proofRoad(store, server.base))
  await sleep(Math.max(0, heldSince + PROOF_STALE_MS + 150 - Date.now()))
  utimesSync(lockDir, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  await until('a waiter has taken the lock that went stale and has its own grant at the server', () => server.grants.length === before + 2)
  server.status = 503
  releaseHolder()
  const displacedEnd = await displaced
  server.status = 200
  check('the holder that lost its lock ends its own exchange, which failed, and writes nothing', displacedEnd.answer.state === 'failed' && stored()?.refreshToken === server.live, JSON.stringify(displacedEnd))
  check('its release leaves the successor\'s lock standing', existsSync(lockDir))
  const third = other(proofRoad(store, server.base))
  await sleep(400)
  check('a third caller sends nothing while the successor is still out', server.grants.length === before + 2, `${server.grants.length - before} grants`)
  releaseSuccessor()
  const [successorEnd, thirdEnd] = await Promise.all([successor, third])
  check('the successor finishes its exchange, the third takes its pair, the grant stands and no lock is left', successorEnd.state === 'refreshed' && thirdEnd.state === 'current' && thirdEnd.pair.refreshToken === successorEnd.pair.refreshToken && server.live !== undefined && stored()?.refreshToken === server.live && server.grants.length === before + 2 && !existsSync(lockDir), JSON.stringify({ successor: told(successorEnd), third: told(thirdEnd), live: server.live, grants: server.grants.length - before, lock: existsSync(lockDir) }))

  console.log('── a caller that gives up waiting is answered at once; the refresh goes on for the others ──')
  seed(liveToken())
  before = server.grants.length
  release = server.hold()
  const busyHolder = child(() => {})
  await until('the holding process has its grant at the server', () => server.grants.length === before + 1)
  const gaveUp = new AbortController()
  const askedAt = Date.now()
  const impatient = mine({ ...proofRoad(store, server.base), signal: gaveUp.signal })
  const patient = mine(proofRoad(store, server.base))
  await sleep(300)
  gaveUp.abort()
  const leftEarly = await Promise.race([impatient, sleep(1_000).then(() => undefined)])
  check('it is answered busy at once with the pair that stands, and nothing was sent', leftEarly?.state === 'busy' && Date.now() - askedAt < 1_300 && server.grants.length === before + 1, JSON.stringify({ answer: leftEarly ? told(leftEarly) : 'no answer one second after it gave up', ms: Date.now() - askedAt }))
  release()
  const [busyHolderEnd, patientEnd] = await Promise.all([busyHolder, patient, impatient])
  check('the caller that kept waiting takes the pair the holder wrote', busyHolderEnd.answer.state === 'refreshed' && patientEnd.state === 'current' && patientEnd.pair.refreshToken === busyHolderEnd.answer.refreshToken && server.grants.length === before + 1, JSON.stringify({ holder: busyHolderEnd.answer, patient: told(patientEnd) }))

  console.log('── a waiter that cannot get the lock in time never refreshes without it ──')
  seed(liveToken())
  const contested = liveToken()
  before = server.grants.length
  release = server.hold()
  const holder = child(() => {})
  await until('the holding process has its grant at the server', () => server.grants.length === before + 1)
  const startedAt = Date.now()
  const waiterCall = mine(proofRoad(store, server.base))
  const waiter = await Promise.race([waiterCall, sleep(PROOF_EXCHANGE_DEADLINE_MS + 6_000).then(() => undefined)])
  const waitedMs = Date.now() - startedAt
  check('it answers busy with the pair that stands, and sent nothing', waiter?.state === 'busy' && waiter.pair.refreshToken === contested && server.grants.length === before + 1, JSON.stringify({ answer: waiter ? told(waiter) : 'no answer while the lock was held', grants: server.grants.length - before }))
  check('it waited longer than the exchange may take before it said so', waitedMs > PROOF_EXCHANGE_DEADLINE_MS + 2_000 && waitedMs < PROOF_EXCHANGE_DEADLINE_MS + 6_000, `${waitedMs} ms`)
  release()
  await waiterCall
  const holderEnd = await holder
  check('the holder then finishes its one exchange and the store holds the live pair', holderEnd.answer.state === 'refreshed' && server.grants.length === before + 1 && server.live !== undefined && stored()?.refreshToken === server.live, JSON.stringify(holderEnd))
} finally {
  server.stop()
}
console.log(failures === 0 ? `\nLOCKED REFRESH GREEN (${passes} checks; two real processes, a loopback token server, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
