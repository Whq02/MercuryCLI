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

const { createFrameReader } = await import('../../src/services/lsp/sidecarFraming.js')

console.log('\nsidecarFraming.ts — createFrameReader reports onMessage error verbatim and keeps reading')
{
  const protocolErrors: string[] = []
  const seen: string[] = []
  const reader = createFrameReader(
    msg => {
      if (msg.method === 'boom') throw new Error('handler bug')
      seen.push(String(msg.method))
    },
    err => {
      protocolErrors.push(err.message)
    },
  )
  const frameOf = (obj: unknown) => {
    const payload = JSON.stringify(obj)
    return Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, 'utf8')
  }
  let threw: unknown = null
  try {
    reader(Buffer.concat([frameOf({ jsonrpc: '2.0', id: 1, method: 'boom' }), frameOf({ jsonrpc: '2.0', id: 2, method: 'after' })]))
  } catch (error) {
    threw = error
  }
  check(
    'createFrameReader hands onMessage error to onProtocolError with its own message and keeps reading the next frame',
    threw === null &&
      protocolErrors.length === 1 &&
      protocolErrors[0] === 'handler bug' &&
      seen.length === 1 &&
      seen[0] === 'after',
    `threw=${String(threw)} protocolErrors=${JSON.stringify(protocolErrors)} seen=${JSON.stringify(seen)}`,
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

const { mediaRuntimeInstalled, runMediaSetup } = await import('../../src/services/media/setup.js')

console.log('\nmedia/setup.ts — onProgress throws are not mislabelled and unreadable runtime.json throws')
{
  const setupDir = join(scratch, 'media-setup')
  const serverDir = join(setupDir, 'server')
  mkdirSync(serverDir, { recursive: true })
  const fakeServer = join(serverDir, 'server.js')
  const fakeSetup = join(serverDir, 'setup.js')
  writeFileSync(fakeServer, '', 'utf8')
  writeFileSync(fakeSetup, `console.log(JSON.stringify({ event: 'progress', file: 'm.bin', bytes: 1, total: 10 }))\nconsole.log(JSON.stringify({ event: 'done' }))\n`, 'utf8')
  let setupErr: unknown = null
  try {
    await runMediaSetup(
      ['pull-runtime'],
      () => {
        throw new Error('progress consumer failed')
      },
      undefined,
      { root: setupDir, serverPath: fakeServer },
    )
  } catch (error) {
    setupErr = error
  }
  check(
    'runMediaSetup rejects with the onProgress error instead of "Media setup returned an unreadable response."',
    setupErr instanceof Error && setupErr.message === 'progress consumer failed',
    `setupErr=${String(setupErr)}`,
  )

  const badRuntimeRoot = join(scratch, 'media-bad-runtime')
  mkdirSync(badRuntimeRoot, { recursive: true })
  writeFileSync(join(badRuntimeRoot, 'runtime.json'), '{not-json', 'utf8')
  const minCatalogue = {
    runtime: { tag: 't1', families: [], componentFamilies: [], platforms: {} },
    models: [],
    files: [],
    recipes: [],
  }
  let rtErr: unknown = null
  try {
    mediaRuntimeInstalled(minCatalogue, badRuntimeRoot, undefined, undefined, 'ok')
  } catch (error) {
    rtErr = error
  }
  check(
    'corrupt runtime.json throws instead of returning false from mediaRuntimeInstalled',
    rtErr instanceof SyntaxError,
    `rtErr=${String(rtErr)}`,
  )

  const absentRuntimeRoot = join(scratch, 'media-absent-runtime')
  mkdirSync(absentRuntimeRoot, { recursive: true })
  check(
    'absent runtime.json still returns false from mediaRuntimeInstalled',
    mediaRuntimeInstalled(minCatalogue, absentRuntimeRoot, undefined, undefined, 'ok') === false,
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
