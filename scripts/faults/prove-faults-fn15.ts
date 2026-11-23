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

const { createFrameReader } = await import('../../src/integrations/lsp/sidecarFraming.js')

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

const { judgeGoal, JUDGE_UNREACHABLE } = await import('../../src/sessions/mission/goalJudge.js')
const { compileGoal } = await import('../../src/sessions/mission/goal.js')

console.log('\ngoalJudge.ts — a helper judge that throws does not hold the goal: the claim decides as before')
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
    'a helper judge that throws leaves the verdict to the claim: met on the claim road, not held as unreachable',
    verdict.kind === 'met' && verdict.road === 'claim' && verdict.reason !== JUDGE_UNREACHABLE,
    JSON.stringify(verdict),
  )
}

const { chmodSync, readFileSync, writeFileSync } = await import('node:fs')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.js')
const { migrateOrphanedMissionCard, readMissionCard, writeMissionCard } = await import('../../src/sessions/mission-card/missionCard.js')
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

const { mediaCheckpointInstalled, mediaFileInstalled, mediaPartialBytes } = await import('../../src/integrations/media/catalogue.js')

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

const { mediaRuntimeInstalled, runMediaSetup } = await import('../../src/integrations/media/setup.js')

console.log('\nmedia/setup.ts — a progress callback that throws does not end the setup, and unreadable runtime.json throws')
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
    'runMediaSetup finishes with its own result when onProgress throws: the setup is not ended and nothing is called an unreadable response',
    setupErr === null,
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

const { createLSPClient } = await import('../../src/integrations/lsp/LSPClient.js')

console.log('\nLSPClient.ts — sendNotification propagates write/serialization failures instead of swallowing')
{
  const fakeLsp = join(scratch, 'fake-lsp.mjs')
  writeFileSync(
    fakeLsp,
    `
    let buf = Buffer.alloc(0)
    process.stdin.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\\r\\n\\r\\n')
      if (idx === -1) return
      const hdr = buf.subarray(0, idx).toString('ascii')
      const m = /content-length:\\s*(\\d+)/i.exec(hdr)
      if (!m) return
      const len = Number(m[1])
      if (buf.length < idx + 4 + len) return
      const body = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString('utf8'))
      buf = buf.subarray(idx + 4 + len)
      if (body.method === 'initialize') {
        const res = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { capabilities: {} } })
        process.stdout.write('Content-Length: ' + Buffer.byteLength(res) + '\\r\\n\\r\\n' + res)
      } else if (body.method === 'shutdown') {
        const res = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })
        process.stdout.write('Content-Length: ' + Buffer.byteLength(res) + '\\r\\n\\r\\n' + res)
      } else if (body.method === 'exit') {
        process.exit(0)
      }
    })
    `,
    'utf8',
  )
  const client = createLSPClient('test-notify')
  await client.start(process.execPath, [fakeLsp])
  await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  let notifyErr: unknown = null
  try {
    await client.sendNotification('textDocument/didChange', cyclic)
  } catch (error) {
    notifyErr = error
  } finally {
    await client.stop({ gracefulTimeoutMs: 500 })
  }
  check(
    'LSPClient.sendNotification rejects when connection.sendNotification throws',
    notifyErr instanceof Error,
    `notifyErr=${String(notifyErr)}`,
  )
}

const { mediaHealth } = await import('../../src/integrations/media/settings.js')

console.log('\nmedia/settings.ts — mediaHealth distinguishes unreadable or corrupt runtime.json from absent')
{
  const healthAbsent = join(scratch, 'media-health-absent')
  mkdirSync(healthAbsent, { recursive: true })
  const absentRow = mediaHealth({ enabled: true, root: healthAbsent })
  check(
    'absent runtime.json still reports Media runtime missing',
    absentRow.status === 'warn' && absentRow.evidence === 'Media runtime missing · /imagesetup',
    JSON.stringify(absentRow),
  )

  const healthCorrupt = join(scratch, 'media-health-corrupt')
  mkdirSync(healthCorrupt, { recursive: true })
  writeFileSync(join(healthCorrupt, 'runtime.json'), '{not-json', 'utf8')
  const corruptRow = mediaHealth({ enabled: true, root: healthCorrupt })
  check(
    'corrupt runtime.json reports Media runtime state could not be read with the parse error',
    corruptRow.status === 'warn' &&
      corruptRow.evidence.startsWith('Media runtime state could not be read (') &&
      corruptRow.evidence.endsWith(') · /imagesetup') &&
      corruptRow.fix === '/imagesetup',
    JSON.stringify(corruptRow),
  )

  if (POSIX_MODES) {
    const healthUnread = join(scratch, 'media-health-unread')
    mkdirSync(healthUnread, { recursive: true })
    const rtPath = join(healthUnread, 'runtime.json')
    writeFileSync(rtPath, JSON.stringify({ binary: '/bin/sh' }), { mode: 0o600 })
    chmodSync(rtPath, 0o200)
    const unreadRow = mediaHealth({ enabled: true, root: healthUnread })
    chmodSync(rtPath, 0o600)
    check(
      'unreadable runtime.json reports Media runtime state could not be read with EACCES',
      unreadRow.status === 'warn' &&
        unreadRow.evidence.startsWith('Media runtime state could not be read (') &&
        unreadRow.evidence.includes('EACCES') &&
        unreadRow.evidence.endsWith(') · /imagesetup'),
      JSON.stringify(unreadRow),
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
