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
  const sampleStore = await import('../../src/integrations/samples/store.ts')

  {
    const session = 'sess-ver-eacces'
    const created = sampleStore.createOrAppendSample({ sessionId: session, name: 'ver-test', html: '<p>ok</p>' })
    const file = join(sampleStore.sampleDir(session, created.record.id), 'v1.html')
    if (POSIX_NON_ROOT) {
      chmodSync(file, 0o000)
      const err = throws(() => sampleStore.readVersion(session, created.record.id, 1))
      chmodSync(file, 0o600)
      check('samples-readVersion-eacces', err !== null, 'returned null instead of throwing on unreadable version; readVersion in src/integrations/samples/store.ts must rethrow a read error other than ENOENT')
    } else {
      skip('samples-readVersion-eacces', 'needs POSIX non-root')
    }
    check('samples-readVersion-enoent-control', sampleStore.readVersion(session, created.record.id, 9) === null, 'readVersion in src/integrations/samples/store.ts must still return null for a version file that does not exist')
  }

  {
    const session = 'sess-marks-corrupt'
    const created = sampleStore.createOrAppendSample({ sessionId: session, name: 'marks-test', html: '<p>m</p>' })
    const marksPath = join(sampleStore.sampleDir(session, created.record.id), 'marks-v1.json')
    const corrupt = '[{"version": 1'
    writeFileSync(marksPath, corrupt, 'utf8')
    const errCorrupt = throws(() => sampleStore.appendMarks(session, created.record.id, { version: 1, pins: [], note: 'new', verdict: null }))
    check('samples-readMarks-corrupt-keeps-file', errCorrupt !== null && readFileSync(marksPath, 'utf8') === corrupt, 'overwrote corrupt marks file; appendMarks in src/integrations/samples/store.ts must throw on unparseable marks and leave the file as it was')
    if (POSIX_NON_ROOT) {
      const valid = JSON.stringify([{ version: 1, pins: [], note: 'keep', verdict: null }])
      writeFileSync(marksPath, valid, 'utf8')
      chmodSync(marksPath, 0o000)
      const errUnreadable = throws(() => sampleStore.appendMarks(session, created.record.id, { version: 1, pins: [], note: 'new', verdict: null }))
      chmodSync(marksPath, 0o600)
      check('samples-readMarks-eacces-keeps-file', errUnreadable !== null && readFileSync(marksPath, 'utf8') === valid, 'overwrote unreadable marks file; appendMarks in src/integrations/samples/store.ts must throw on an unreadable marks file and leave it as it was')
    } else {
      skip('samples-readMarks-eacces-keeps-file', 'needs POSIX non-root')
    }
  }

  const structureQuery = await import('../../src/tools/engines/structure/query.ts')
  {
    const root = join(SCRATCH, 'struct-query')
    const sub = join(root, 'locked-dir')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(root, 'ok.ts'), 'export function okFn() { return 1 }\n', 'utf8')
    const lockedFile = join(root, 'locked.ts')
    writeFileSync(lockedFile, 'export function secretFn() { return 2 }\n', 'utf8')
    const brokenLink = join(root, 'broken.ts')
    if (POSIX_NON_ROOT) {
      symlinkSync(join(root, 'does-not-exist.ts'), brokenLink)
      chmodSync(sub, 0o000)
      chmodSync(lockedFile, 0o000)
      const res = structureQuery.runStructureQuery(root, { select: 'function' })
      chmodSync(sub, 0o700)
      chmodSync(lockedFile, 0o600)
      const failedFiles = 'parseFailures' in res ? res.parseFailures.map(f => f.file) : []
      check('structure-query-unreadable-dir-reported', failedFiles.includes('locked-dir'), `parseFailures=${JSON.stringify(failedFiles)}; runStructureQuery in src/tools/engines/structure/query.ts must list an unreadable directory in parseFailures`)
      check('structure-query-broken-stat-reported', failedFiles.includes('broken.ts'), `parseFailures=${JSON.stringify(failedFiles)}; runStructureQuery in src/tools/engines/structure/query.ts must list a file whose stat fails in parseFailures`)
      check('structure-query-unreadable-file-reported', failedFiles.includes('locked.ts'), `parseFailures=${JSON.stringify(failedFiles)}; runStructureQuery in src/tools/engines/structure/query.ts must list an unreadable file in parseFailures`)
    } else {
      skip('structure-query-unreadable-dir-reported', 'needs POSIX non-root')
      skip('structure-query-broken-stat-reported', process.platform === 'win32' ? 'not read on Windows: no symlink privilege' : 'needs POSIX non-root')
      skip('structure-query-unreadable-file-reported', 'needs POSIX non-root')
    }
  }

  const adapterServe = await import('../../src/models/tensorfold/adapter/serve.ts')
  const adapterIdentity = await import('../../src/models/tensorfold/adapter/identity.ts')
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
      check('adapter-serve-unreadable-pidfile-not-deleted', reapErr !== null && kept, `err=${String(reapErr)} kept=${String(kept)}; reapStaleChild in src/models/tensorfold/adapter/serve.ts must throw on an unreadable pid file and must not delete it`)
    } else {
      rmSync(pidPath, { force: true })
      skip('adapter-serve-unreadable-pidfile-not-deleted', 'needs POSIX non-root')
    }
    check('adapter-serve-absent-pidfile-control', adapterServe.readChildPidFile(59124) === undefined, 'readChildPidFile in src/models/tensorfold/adapter/serve.ts must return undefined for an absent pid file')

    let rememberErr: unknown = null
    try {
      await adapterServe.rememberChild(59125, 12345, async () => {
        throw new Error('token-probe-failed')
      })
    } catch (err) {
      rememberErr = err
    }
    check('adapter-serve-rememberChild-rejects-on-failure', rememberErr !== null, 'swallowed startToken failure silently; rememberChild in src/models/tensorfold/adapter/serve.ts must reject when its token probe throws')
  }

  const tfServe = await import('../../src/models/tensorfold/serve.ts')
  {
    const servedDir = join(SCRATCH, 'tf-serve')
    mkdirSync(servedDir, { recursive: true })
    const corruptFile = join(servedDir, 'corrupt-served.json')
    writeFileSync(corruptFile, '{"repo": "broken', 'utf8')
    let stopCorruptErr: unknown = null
    try {
      await tfServe.stopTensorFold('qwen', { servedFile: corruptFile })
    } catch (err) {
      stopCorruptErr = err
    }
    check('tensorfold-serve-stop-corrupt-record-answers-as-before', stopCorruptErr === null, `err=${String(stopCorruptErr)}; stopTensorFold in src/models/tensorfold/serve.ts must answer as before when the served record is corrupt, not throw`)

    let startCorruptErr: unknown = null
    try {
      await tfServe.startTensorFold(
        { repo: 'org/model', window: 32768 },
        {
          binary: '/bin/true',
          servedFile: corruptFile,
          machine: { platform: 'linux', ramBytes: 64 * 1024 ** 3, usableBytes: 48 * 1024 ** 3, usableSource: 'cuda', chip: 'test' },
          freeMemoryBytes: async () => 48 * 1024 ** 3,
        },
      )
    } catch (err) {
      startCorruptErr = err
    }
    check(
      'tensorfold-serve-start-corrupt-record-refuses',
      startCorruptErr instanceof tfServe.TensorFoldStartError &&
        startCorruptErr.message.includes('could not be read') &&
        startCorruptErr.message.includes('nothing was started') &&
        startCorruptErr.message.includes(corruptFile) &&
        readFileSync(corruptFile, 'utf8') === '{"repo": "broken',
      `err=${String(startCorruptErr)}; startTensorFold in src/models/tensorfold/serve.ts must throw TensorFoldStartError saying the record could not be read, nothing was started and naming the file, and leave the file unchanged`,
    )

    if (POSIX_NON_ROOT) {
      const lockedFile = join(servedDir, 'locked-served.json')
      writeFileSync(lockedFile, '{"repo":"org/m","name":"m","port":8080,"window":32768,"pid":1,"startedAt":"2026-01-01T00:00:00Z","project":"/tmp"}\n', 'utf8')
      chmodSync(lockedFile, 0o000)
      let stopLockedErr: unknown = null
      try {
        await tfServe.stopTensorFold('m', { servedFile: lockedFile })
      } catch (err) {
        stopLockedErr = err
      }
      chmodSync(lockedFile, 0o600)
      check('tensorfold-serve-stop-eacces-record-answers-as-before', stopLockedErr === null, `err=${String(stopLockedErr)}; stopTensorFold in src/models/tensorfold/serve.ts must answer as before when the served record is unreadable, not throw`)
    } else {
      skip('tensorfold-serve-stop-eacces-record-answers-as-before', 'needs POSIX non-root')
    }

    const nullFile = join(servedDir, 'null-served.json')
    writeFileSync(nullFile, 'null\n', 'utf8')
    let stopNullErr: unknown = null
    try {
      await tfServe.stopTensorFold('m', { servedFile: nullFile })
      await tfServe.stopTensorFold('m', { servedFile: join(servedDir, 'absent.json') })
    } catch (err) {
      stopNullErr = err
    }
    check('tensorfold-serve-stop-null-and-absent-control', stopNullErr === null, `err=${String(stopNullErr)}; stopTensorFold in src/models/tensorfold/serve.ts must accept a null or absent served record without throwing`)
  }
}

try {
  await run()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
