#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  const structureQuery = await import('../../src/services/structure/query.ts')
  {
    const root = join(SCRATCH, 'struct-query')
    const sub = join(root, 'locked-dir')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(root, 'ok.ts'), 'export function okFn() { return 1 }\n', 'utf8')
    const lockedFile = join(root, 'locked.ts')
    writeFileSync(lockedFile, 'export function secretFn() { return 2 }\n', 'utf8')
    const brokenLink = join(root, 'broken.ts')
    symlinkSync(join(root, 'does-not-exist.ts'), brokenLink)
    if (POSIX_NON_ROOT) {
      chmodSync(sub, 0o000)
      chmodSync(lockedFile, 0o000)
      const res = structureQuery.runStructureQuery(root, { select: 'function' })
      chmodSync(sub, 0o700)
      chmodSync(lockedFile, 0o600)
      const failedFiles = 'parseFailures' in res ? res.parseFailures.map(f => f.file) : []
      check('structure-query-unreadable-dir-reported', failedFiles.includes('locked-dir'), `parseFailures=${JSON.stringify(failedFiles)}`)
      check('structure-query-broken-stat-reported', failedFiles.includes('broken.ts'), `parseFailures=${JSON.stringify(failedFiles)}`)
      check('structure-query-unreadable-file-reported', failedFiles.includes('locked.ts'), `parseFailures=${JSON.stringify(failedFiles)}`)
    } else {
      skip('structure-query-unreadable-dir-reported', 'needs POSIX non-root')
      skip('structure-query-broken-stat-reported', 'needs POSIX non-root')
      skip('structure-query-unreadable-file-reported', 'needs POSIX non-root')
    }
  }

  const adapterServe = await import('../../src/services/tensorfold/adapter/serve.ts')
  const adapterIdentity = await import('../../src/services/tensorfold/adapter/identity.ts')
  {
    const port = 59123
    const pidPath = adapterIdentity.adapterChildPidFile(port)
    await adapterServe.rememberChild(port, 999999, async () => 'TOK1')
    if (POSIX_NON_ROOT) {
      chmodSync(pidPath, 0o000)
      let reapErr: unknown = null
      try {
        await adapterServe.reapStaleChild(port, 'darwin', () => undefined)
      } catch (err) {
        reapErr = err
      }
      chmodSync(pidPath, 0o600)
      let kept = false
      try {
        kept = readFileSync(pidPath, 'utf8').includes('999999')
      } catch {
        kept = false
      }
      rmSync(pidPath, { force: true })
      check('adapter-serve-unreadable-pidfile-not-deleted', reapErr !== null && kept, `err=${String(reapErr)} kept=${String(kept)}`)
    } else {
      rmSync(pidPath, { force: true })
      skip('adapter-serve-unreadable-pidfile-not-deleted', 'needs POSIX non-root')
    }
    check('adapter-serve-absent-pidfile-control', adapterServe.readChildPidFile(59124) === undefined)

    let rememberErr: unknown = null
    try {
      await adapterServe.rememberChild(59125, 12345, async () => {
        throw new Error('token-probe-failed')
      })
    } catch (err) {
      rememberErr = err
    }
    check('adapter-serve-rememberChild-rejects-on-failure', rememberErr !== null, 'swallowed startToken failure silently')
  }
}

try {
  await run()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
