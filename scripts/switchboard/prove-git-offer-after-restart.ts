#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STAGE = process.env.GIT_OFFER_RESTART_STAGE
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

if (STAGE === 'answer') {
  const asks = await import('../../src/daemon/permissionAsks.js')
  const obligations = await import('../../src/services/crew/obligations.js')
  const requestId = process.env.GIT_OFFER_RESTART_ID ?? ''
  const allow = process.env.GIT_OFFER_RESTART_ALLOW === 'yes'
  const rowOf = async (): Promise<{ status: string; by?: string } | null> => {
    const row = (await obligations.listObligations({ scope: 'switchboard' })).filter(o => o.ref === `permission:${requestId}`).pop()
    return row === undefined ? null : { status: row.status, ...(row.settlement?.by !== undefined ? { by: row.settlement.by } : {}) }
  }
  const heldBefore = asks.listPendingPermissionAsks().some(a => a.requestId === requestId)
  const first = asks.answerPermissionAsk(requestId, allow, 'operator')
  let afterFirst = await rowOf()
  for (let i = 0; i < 40 && afterFirst?.status === 'open'; i++) {
    await sleep(50)
    afterFirst = await rowOf()
  }
  const second = asks.answerPermissionAsk(requestId, allow, 'operator')
  await sleep(600)
  console.log(JSON.stringify({ heldBefore, first, afterFirst, second, afterSecond: await rowOf() }))
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'git-offer-restart-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const yesFolder = join(SCRATCH, 'project-yes')
const noFolder = join(SCRATCH, 'project-no')
for (const d of [home, daemonDir, yesFolder, noFolder]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const asks = await import('../../src/daemon/permissionAsks.js')
const obligations = await import('../../src/services/crew/obligations.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

interface Answered {
  heldBefore: boolean
  first: { outcome: string; detail?: string }
  afterFirst: { status: string; by?: string } | null
  second: { outcome: string; detail?: string }
  afterSecond: { status: string; by?: string } | null
}
const answerInANewProcess = (requestId: string, allow: boolean): Answered | null => {
  const res = spawnSync(process.execPath, [import.meta.path], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GIT_OFFER_RESTART_STAGE: 'answer', GIT_OFFER_RESTART_ID: requestId, GIT_OFFER_RESTART_ALLOW: allow ? 'yes' : 'no' },
  })
  const line = (res.stdout ?? '').trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(line) as Answered
  } catch {
    console.log(`  [the answering process said] ${(res.stdout ?? '').slice(-300)} ${(res.stderr ?? '').slice(-300)}`)
    return null
  }
}
const openRowSoon = async (requestId: string): Promise<boolean> => {
  for (let i = 0; i < 60; i++) {
    if ((await obligations.openObligations({ scope: 'switchboard' })).some(o => o.ref === `permission:${requestId}`)) return true
    await sleep(50)
  }
  return false
}

console.log('a git offer answered after the daemon that raised it is gone: the answer applies once and the card leaves with it')
for (const [folder, allow] of [[yesFolder, true], [noFolder, false]] as const) {
  const word = allow ? 'Yes' : 'No'
  const minted = asks.mintGitInitAsk(folder) as { requestId: string }
  check(`${word}: the first daemon raises the offer and its card stands (the row and the sidecar are on disk)`, typeof minted.requestId === 'string' && (await openRowSoon(minted.requestId)) && existsSync(join(daemonDir, 'git-init-asks.json')), JSON.stringify(minted))
  const said = answerInANewProcess(minted.requestId, allow)
  check(`${word}: the next daemon holds nothing in memory and still knows the offer from its sidecar`, said !== null && said.heldBefore === false && said.first.outcome === 'applied', JSON.stringify(said))
  check(`${word}: …and the first answer settles the card as answered by the operator (red on the base: the row stays open and the card stands)`, said?.afterFirst?.status === 'answered' && said.afterFirst.by === 'operator', JSON.stringify(said?.afterFirst))
  check(`${word}: a second answer finds nothing to answer and leaves the settled row as it is`, said?.second.outcome === 'refused' && said.afterSecond?.status === 'answered' && said.afterSecond.by === 'operator', JSON.stringify({ second: said?.second, afterSecond: said?.afterSecond }))
  check(`${word}: the folder is ${allow ? 'a repository now' : 'left without git'}`, existsSync(join(folder, '.git')) === allow)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-git-offer-after-restart: ALL LAWS HOLD' : `\nprove-git-offer-after-restart: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
