#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-faults-fn21-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

const POSIX_NON_ROOT = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
function throws(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}

async function run(): Promise<void> {
  const sampleStore = await import('../../src/services/samples/store.ts')

  {
    const session = 'sess-list-eacces'
    const root = sampleStore.samplesRoot(session)
    mkdirSync(root, { recursive: true })
    if (POSIX_NON_ROOT) {
      chmodSync(root, 0o000)
      const err = throws(() => sampleStore.listSamples(session))
      chmodSync(root, 0o700)
      check('samples-listSamples-eacces', err !== null, 'returned [] instead of throwing on unreadable samples root')
    } else {
      skip('samples-listSamples-eacces', 'needs POSIX non-root')
    }
    check('samples-listSamples-enoent-control', sampleStore.listSamples('sess-never-created').length === 0)
  }

  {
    const session = 'sess-ver-eacces'
    const created = sampleStore.createOrAppendSample({ sessionId: session, name: 'ver-test', html: '<p>ok</p>' })
    const file = join(sampleStore.sampleDir(session, created.record.id), 'v1.html')
    if (POSIX_NON_ROOT) {
      chmodSync(file, 0o000)
      const err = throws(() => sampleStore.readVersion(session, created.record.id, 1))
      chmodSync(file, 0o600)
      check('samples-readVersion-eacces', err !== null, 'returned null instead of throwing on unreadable version')
    } else {
      skip('samples-readVersion-eacces', 'needs POSIX non-root')
    }
    check('samples-readVersion-enoent-control', sampleStore.readVersion(session, created.record.id, 9) === null)
  }

  {
    const session = 'sess-marks-corrupt'
    const created = sampleStore.createOrAppendSample({ sessionId: session, name: 'marks-test', html: '<p>m</p>' })
    const marksPath = join(sampleStore.sampleDir(session, created.record.id), 'marks-v1.json')
    const corrupt = '[{"version": 1'
    writeFileSync(marksPath, corrupt, 'utf8')
    const errCorrupt = throws(() => sampleStore.appendMarks(session, created.record.id, { version: 1, pins: [], note: 'new', verdict: null }))
    check('samples-readMarks-corrupt-keeps-file', errCorrupt !== null && readFileSync(marksPath, 'utf8') === corrupt, 'overwrote corrupt marks file')
    if (POSIX_NON_ROOT) {
      const valid = JSON.stringify([{ version: 1, pins: [], note: 'keep', verdict: null }])
      writeFileSync(marksPath, valid, 'utf8')
      chmodSync(marksPath, 0o000)
      const errUnreadable = throws(() => sampleStore.appendMarks(session, created.record.id, { version: 1, pins: [], note: 'new', verdict: null }))
      chmodSync(marksPath, 0o600)
      check('samples-readMarks-eacces-keeps-file', errUnreadable !== null && readFileSync(marksPath, 'utf8') === valid, 'overwrote unreadable marks file')
    } else {
      skip('samples-readMarks-eacces-keeps-file', 'needs POSIX non-root')
    }
  }
}

try {
  await run()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
