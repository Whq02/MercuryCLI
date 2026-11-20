#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function makeScratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `faults-fn07-${prefix}-`))
}

function threwOf(fn: () => unknown): Error | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

{
  console.log('\nmnemeLibrary-writeLibraryMeta-unreadable')
  const { readLibraryMeta, writeLibraryMeta, libraryMetaPath } = await import('../../src/mneme/mnemeLibrary.ts')
  const dir = makeScratch('libmeta')
  try {
    const fresh = readLibraryMeta(dir)
    check('absent library.json returns fresh meta', fresh.seqCounter === 0 && fresh.lastConsolidatedAt === null)

    const p = libraryMetaPath(dir)
    const rawValid = JSON.stringify({ version: 1, seqCounter: 42, lastConsolidatedAt: '2026-01-01T00:00:00.000Z' })
    writeFileSync(p, rawValid)
    check('valid library.json reads seqCounter', readLibraryMeta(dir).seqCounter === 42)

    writeFileSync(p, '{corrupt')
    check('corrupt library.json keeps readLibraryMeta non-throwing for outside callers', readLibraryMeta(dir).seqCounter === 0)
    const parseErr = threwOf(() => writeLibraryMeta({ version: 1, seqCounter: 1, lastConsolidatedAt: null }, dir))
    check('writeLibraryMeta refuses to overwrite corrupt library.json', parseErr !== null && readFileSync(p, 'utf8') === '{corrupt', String(parseErr))

    if (POSIX_MODES) {
      writeFileSync(p, rawValid, { mode: 0o600 })
      chmodSync(p, 0o200)
      check('unreadable library.json keeps readLibraryMeta non-throwing for outside callers', readLibraryMeta(dir).seqCounter === 0)
      const permErr = threwOf(() => writeLibraryMeta({ version: 1, seqCounter: 1, lastConsolidatedAt: null }, dir))
      chmodSync(p, 0o600)
      check('writeLibraryMeta throws EACCES and keeps unreadable library.json intact', permErr !== null && (permErr as NodeJS.ErrnoException).code === 'EACCES' && readFileSync(p, 'utf8') === rawValid, String(permErr))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  console.log('\nmnemeMaintenance-appendReceipt-unreadable')
  const { readMaintenanceReceipts, runDueMaintenance } = await import('../../src/mneme/mnemeMaintenance.ts')
  const dir = makeScratch('maint-receipts')
  try {
    check('absent maintenance.jsonl returns empty list', readMaintenanceReceipts(dir).length === 0)
    const p = join(dir, 'maintenance.jsonl')
    const prior = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', trigger: 'operator', ran: true, reason: 'prior' }) + '\n'
    writeFileSync(p, prior, { mode: 0o600 })
    check('readable maintenance.jsonl returns prior receipt', readMaintenanceReceipts(dir).length === 1)
    if (POSIX_MODES) {
      chmodSync(p, 0o200)
      const list = readMaintenanceReceipts(dir)
      await runDueMaintenance('operator', { dir, force: true })
      chmodSync(p, 0o600)
      check('readMaintenanceReceipts stays non-throwing for outside UI callers', list.length === 0)
      check('appendReceipt does not wipe unreadable maintenance.jsonl', readFileSync(p, 'utf8') === prior, readFileSync(p, 'utf8'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  console.log('\nmnemeUsage-pinWriters-unreadable')
  const { readPins, pinFact, unpinFact, movePin, pinsPath } = await import('../../src/mneme/mnemeUsage.ts')
  const dir = makeScratch('pins')
  try {
    check('absent pins.json returns empty list', readPins(dir).length === 0)
    const p = pinsPath(dir)
    const prior = JSON.stringify({ version: 1, pins: [{ seq: 7, at: '2026-01-01T00:00:00.000Z', asked: true }] }, null, 1)
    writeFileSync(p, prior, { mode: 0o600 })
    check('valid pins.json reads prior pin', readPins(dir).length === 1 && readPins(dir)[0]!.seq === 7)

    writeFileSync(p, '{corrupt', { mode: 0o600 })
    check('corrupt pins.json keeps readPins non-throwing for outside callers', readPins(dir).length === 0)
    check('corrupt pins.json throws on pinFact without replacing file', threwOf(() => pinFact(9, dir)) !== null && readFileSync(p, 'utf8') === '{corrupt')

    if (POSIX_MODES) {
      writeFileSync(p, prior, { mode: 0o600 })
      chmodSync(p, 0o200)
      const list = readPins(dir)
      const pinErr = threwOf(() => pinFact(9, dir))
      const unpinErr = threwOf(() => unpinFact(7, dir))
      const moveErr = threwOf(() => movePin(7, 8, dir))
      chmodSync(p, 0o600)
      check('unreadable pins.json keeps readPins non-throwing for outside callers', list.length === 0)
      check('pinFact/unpinFact/movePin refuse unreadable pins.json with EACCES and keep file intact', (pinErr as NodeJS.ErrnoException | null)?.code === 'EACCES' && (unpinErr as NodeJS.ErrnoException | null)?.code === 'EACCES' && (moveErr as NodeJS.ErrnoException | null)?.code === 'EACCES' && readFileSync(p, 'utf8') === prior)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  console.log('\nmnemeUsage-bumpUsage-unreadable')
  const { readUsage, bumpUsage, usagePath } = await import('../../src/mneme/mnemeUsage.ts')
  const dir = makeScratch('usage')
  try {
    check('absent usage.json returns empty map', Object.keys(readUsage(dir)).length === 0)
    const p = usagePath(dir)
    const prior = JSON.stringify({ version: 1, rows: { '5': { last: '2026-01-01T00:00:00.000Z', count: 12 } } })
    writeFileSync(p, prior, { mode: 0o600 })
    check('valid usage.json reads prior count', readUsage(dir)['5']?.count === 12)

    writeFileSync(p, '{corrupt', { mode: 0o600 })
    check('corrupt usage.json keeps readUsage non-throwing for outside callers', Object.keys(readUsage(dir)).length === 0)
    bumpUsage([9], dir)
    check('bumpUsage leaves corrupt usage.json untouched', readFileSync(p, 'utf8') === '{corrupt', readFileSync(p, 'utf8'))

    if (POSIX_MODES) {
      writeFileSync(p, prior, { mode: 0o600 })
      chmodSync(p, 0o200)
      const rows = readUsage(dir)
      bumpUsage([9], dir)
      chmodSync(p, 0o600)
      check('unreadable usage.json keeps readUsage non-throwing for outside callers', Object.keys(rows).length === 0)
      check('bumpUsage leaves unreadable usage.json untouched', readFileSync(p, 'utf8') === prior, readFileSync(p, 'utf8'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  console.log('\nmercuryRequests-run-sidecar-throw')
  const { mock } = await import('bun:test')
  const realSidecar = await import('../../src/services/run/runSidecar.ts')
  let sidecarMode: 'absent' | 'throw' = 'absent'
  mock.module('../../src/services/run/runSidecar.ts', () => ({
    ...realSidecar,
    loadRunSidecar: async () => {
      if (sidecarMode === 'throw') throw new Error('sidecar EIO')
      return { state: 'absent' as const }
    },
  }))
  const { mercuryRequests } = await import('../../src/services/acp/acpServer/mercuryRequests.ts')
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>()
  const app = {
    onRequest(name: string, _parse: unknown, handler: (ctx: { params: unknown }) => unknown) {
      handlers.set(name, handler)
      return app
    },
  }
  mercuryRequests(app as never)
  const runHandler = handlers.get('_mercury/run')!
  sidecarMode = 'absent'
  const absentRes = (await runHandler({ params: {} })) as { run?: unknown; unavailable?: unknown }
  check('absent run sidecar answers run: null', absentRes.run === null && absentRes.unavailable === undefined, JSON.stringify(absentRes))
  sidecarMode = 'throw'
  const throwRes = (await runHandler({ params: {} })) as { run?: unknown; unavailable?: unknown; retryable?: unknown }
  check('throwing loadRunSidecar answers unavailable instead of run: null', throwRes.unavailable === 'sidecar EIO' && throwRes.retryable === false && !('run' in throwRes), JSON.stringify(throwRes))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
