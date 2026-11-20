#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-faults-fn15-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { workspaceSymbolRequest } = await import('../../src/services/lsp/tsSidecar/sidecar/requests/navigation.js')
const { createFrameReader } = await import('../../src/services/lsp/sidecarFraming.js')

console.log('\nnavigation.ts — workspaceSymbolRequest propagates project getNavigateToItems failures')
{
  const brokenProject = {
    service: {
      getNavigateToItems: () => {
        throw new Error('ts language service exploded')
      },
    },
  }
  const fakeState = {
    workspaceProjects: () => [brokenProject],
    allProjects: () => [brokenProject],
    normalize: (p: string) => p,
    textOf: () => '',
  }
  let threw: unknown = null
  try {
    workspaceSymbolRequest({ query: 'foo' }, () => fakeState as never)
  } catch (error) {
    threw = error
  }
  check(
    'workspaceSymbolRequest throws instead of returning an empty symbol list',
    threw instanceof Error && threw.message === 'ts language service exploded',
    `threw=${String(threw)}`,
  )
}

console.log('\nsidecarFraming.ts — createFrameReader does not mislabel onMessage errors as unparseable JSON')
{
  const protocolErrors: string[] = []
  const reader = createFrameReader(
    () => {
      throw new Error('handler bug')
    },
    err => {
      protocolErrors.push(err.message)
    },
  )
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, 'utf8')
  let threw: unknown = null
  try {
    reader(frame)
  } catch (error) {
    threw = error
  }
  check(
    'createFrameReader lets onMessage throw instead of reporting unparseable JSON-RPC body',
    threw instanceof Error && threw.message === 'handler bug' && protocolErrors.length === 0,
    `threw=${String(threw)} protocolErrors=${JSON.stringify(protocolErrors)}`,
  )
  const badErrors: string[] = []
  const badReader = createFrameReader(() => {}, err => badErrors.push(err.message))
  const badBody = '{not-json'
  badReader(Buffer.from(`Content-Length: ${Buffer.byteLength(badBody)}\r\n\r\n${badBody}`, 'utf8'))
  check(
    'createFrameReader still reports unparseable JSON-RPC body on malformed JSON',
    badErrors.length === 1 && badErrors[0] === 'unparseable JSON-RPC body',
    `badErrors=${JSON.stringify(badErrors)}`,
  )
}

const { judgeGoal, JUDGE_UNREACHABLE } = await import('../../src/services/mission/goalJudge.js')
const { compileGoal } = await import('../../src/services/mission/goal.js')

console.log('\ngoalJudge.ts — judgeGoal fails closed when helper judge throws')
{
  const goal = compileGoal('the parser suite is green')
  const evidence = {
    closing: '1. the parser suite is green — all passing\nMERCURY_MISSION_MET',
    claimedMet: true,
    asksOperator: false,
    toolCalls: 1,
    toolNames: ['Bash'],
    verification: null,
    checks: 0,
  }
  const verdict = await judgeGoal(goal, evidence, {
    judge: async () => {
      throw new Error('judge exploded')
    },
  })
  check(
    'throwing helper judge yields not yet (JUDGE_UNREACHABLE) instead of falling through to met claim',
    verdict.kind === 'not yet' && verdict.reason === JUDGE_UNREACHABLE,
    JSON.stringify(verdict),
  )
}

const { chmodSync, readFileSync, writeFileSync } = await import('node:fs')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.js')
const { migrateOrphanedMissionCard, readMissionCard, writeMissionCard } = await import('../../src/services/mission/missionCard.js')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

console.log('\nmissionCard.ts — migrateOrphanedMissionCard never clobbers corrupt/unreadable cards and never reports success on failed write')
{
  const makeOrphan = (cwd: string, orphanId: string) => {
    mkdirSync(cwd, { recursive: true })
    writeMissionCard(
      {
        schema: 1,
        sessionId: orphanId,
        goal: 'orphan goal',
        state: 'armed',
        nextStep: 'keep going',
        iterations: 1,
        setAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      },
      cwd,
    )
    return join(getProjectDir(cwd), 'missions')
  }

  const corruptCwd = join(scratch, 'mission-corrupt')
  const corruptDir = makeOrphan(corruptCwd, 'orphan-1')
  const targetPath = join(corruptDir, 'conv-corrupt.json')
  writeFileSync(targetPath, '{broken json', 'utf8')
  const migratedCorrupt = migrateOrphanedMissionCard('conv-corrupt', corruptCwd)
  check(
    'migrateOrphanedMissionCard refuses to overwrite a corrupt card and leaves the orphan armed',
    migratedCorrupt === false &&
      readFileSync(targetPath, 'utf8') === '{broken json' &&
      readMissionCard('orphan-1', corruptCwd)?.state === 'armed',
    `migrated=${migratedCorrupt} target=${readFileSync(targetPath, 'utf8')} orphan=${readMissionCard('orphan-1', corruptCwd)?.state}`,
  )

  if (POSIX_MODES) {
    const unreadCwd = join(scratch, 'mission-unreadable')
    const unreadDir = makeOrphan(unreadCwd, 'orphan-2')
    const unreadPath = join(unreadDir, 'conv-unread.json')
    const keptBytes = JSON.stringify({ schema: 1, sessionId: 'conv-unread', goal: 'existing goal', state: 'armed', nextStep: null, iterations: 2, setAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z' })
    writeFileSync(unreadPath, keptBytes, { mode: 0o600 })
    chmodSync(unreadPath, 0o200)
    const migratedUnread = migrateOrphanedMissionCard('conv-unread', unreadCwd)
    chmodSync(unreadPath, 0o600)
    check(
      'migrateOrphanedMissionCard refuses to overwrite an unreadable card and leaves the orphan armed',
      migratedUnread === false &&
        readFileSync(unreadPath, 'utf8') === keptBytes &&
        readMissionCard('orphan-2', unreadCwd)?.state === 'armed',
      `migrated=${migratedUnread} same=${readFileSync(unreadPath, 'utf8') === keptBytes} orphan=${readMissionCard('orphan-2', unreadCwd)?.state}`,
    )

    const readonlyCwd = join(scratch, 'mission-readonly')
    const readonlyDir = makeOrphan(readonlyCwd, 'orphan-3')
    chmodSync(readonlyDir, 0o500)
    const migratedReadonly = migrateOrphanedMissionCard('conv-readonly', readonlyCwd)
    chmodSync(readonlyDir, 0o700)
    check(
      'migrateOrphanedMissionCard returns false when the new card write fails',
      migratedReadonly === false && readMissionCard('orphan-3', readonlyCwd)?.state === 'armed',
      `migrated=${migratedReadonly} orphan=${readMissionCard('orphan-3', readonlyCwd)?.state}`,
    )
  }
}

const { mediaCheckpointInstalled, mediaFileInstalled, mediaPartialBytes } = await import('../../src/services/media/catalogue.js')

console.log('\nmedia/catalogue.ts — path guard and non-absence stat errors propagate instead of reading as absent')
{
  const mediaDir = join(scratch, 'media-cat')
  mkdirSync(join(mediaDir, 'models', 'checkpoints'), { recursive: true })
  const recipeCat = { recipes: [{ id: 'sdxl', slots: [{ id: 'd', required: true }], checkpoint: { recipe: 'sdxl-checkpoint', layout: 'sdxl' } }] }

  const threwOf = (fn: () => unknown): unknown => {
    try {
      fn()
      return null
    } catch (error) {
      return error
    }
  }

  const badCheckpoint = threwOf(() => mediaCheckpointInstalled(mediaDir, recipeCat, { id: '../escape', recipe: 'sdxl', checkpoint: { bytes: 8 } }))
  const badPartial = threwOf(() => mediaPartialBytes(mediaDir, { path: '../escape.bin', bytes: 8 }))
  const badFile = threwOf(() => mediaFileInstalled(mediaDir, { path: '../escape.bin', bytes: 8 }))
  check(
    'path traversal throws from mediaCheckpointInstalled, mediaPartialBytes, and mediaFileInstalled',
    badCheckpoint instanceof Error &&
      badCheckpoint.message.includes('models folder') &&
      badPartial instanceof Error &&
      badPartial.message.includes('models folder') &&
      badFile instanceof Error &&
      badFile.message.includes('models folder'),
    `checkpoint=${String(badCheckpoint)} partial=${String(badPartial)} file=${String(badFile)}`,
  )

  check(
    'absent files still return false / 0',
    mediaCheckpointInstalled(mediaDir, recipeCat, { id: 'missing', recipe: 'sdxl', checkpoint: { bytes: 8 } }) === false &&
      mediaPartialBytes(mediaDir, { path: 'missing.bin', bytes: 8 }) === 0 &&
      mediaFileInstalled(mediaDir, { path: 'missing.bin', bytes: 8 }) === false,
  )

  if (POSIX_MODES) {
    const blockedModels = join(mediaDir, 'models')
    chmodSync(blockedModels, 0o000)
    const e1 = threwOf(() => mediaCheckpointInstalled(mediaDir, recipeCat, { id: 'ok', recipe: 'sdxl', checkpoint: { bytes: 8 } }))
    const e2 = threwOf(() => mediaPartialBytes(mediaDir, { path: 'ok.bin', bytes: 8 }))
    const e3 = threwOf(() => mediaFileInstalled(mediaDir, { path: 'ok.bin', bytes: 8 }))
    chmodSync(blockedModels, 0o700)
    check(
      'EACCES on models dir throws from mediaCheckpointInstalled, mediaPartialBytes, and mediaFileInstalled',
      (e1 as NodeJS.ErrnoException | null)?.code === 'EACCES' &&
        (e2 as NodeJS.ErrnoException | null)?.code === 'EACCES' &&
        (e3 as NodeJS.ErrnoException | null)?.code === 'EACCES',
      `e1=${String(e1)} e2=${String(e2)} e3=${String(e3)}`,
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
