#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchHome = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-faults-fn14-home-')))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function throwsMatching(fn: () => unknown, pattern: RegExp): { threw: boolean; message: string } {
  try {
    fn()
    return { threw: false, message: '(did not throw)' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { threw: pattern.test(message), message }
  }
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

{
  const { parseGodotProjectFile, _resetGodotSessionForTesting } = await import('../../src/services/ide/godotSession.ts')
  const dir = makeTempDir('fn14-godot-')
  try {
    _resetGodotSessionForTesting()
    const absent = parseGodotProjectFile(dir)
    check('godotSession: absent project.godot returns empty', Object.keys(absent).length === 0, JSON.stringify(absent))
    if (POSIX_MODES) {
      const proj = join(dir, 'project.godot')
      writeFileSync(proj, '[application]\nconfig/name="Demo"\n')
      chmodSync(proj, 0o200)
      try {
        _resetGodotSessionForTesting()
        const r = throwsMatching(() => parseGodotProjectFile(dir), /EACCES|permission/i)
        check('godotSession: unreadable project.godot throws instead of empty', r.threw, r.message)
      } finally {
        chmodSync(proj, 0o600)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { getTransaction, latestTransaction, listTransactions, openTransactionIdFor } = await import('../../src/services/ide/ideTransaction.ts')
  const { projectHomeStore } = await import('../../src/utils/projectHomeStores.ts')
  const dir = makeTempDir('fn14-idetx-')
  try {
    check('ideTransaction: absent store returns null and empty list', latestTransaction(dir) === null && listTransactions(dir).length === 0)
    const store = projectHomeStore(dir, 'ide-transactions')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'latest.json'), '{not-json')
    writeFileSync(join(store, 'tx-100-abc.json'), '{not-json')
    const r1 = throwsMatching(() => latestTransaction(dir), /corrupt|JSON|parse/i)
    const r2 = throwsMatching(() => getTransaction('tx-100-abc', dir), /corrupt|JSON|parse/i)
    const r3 = throwsMatching(() => listTransactions(dir), /corrupt|JSON|parse/i)
    const r4 = throwsMatching(() => openTransactionIdFor(dir), /corrupt|JSON|parse/i)
    check('ideTransaction: corrupt latest.json throws on latestTransaction', r1.threw, r1.message)
    check('ideTransaction: corrupt record throws on getTransaction', r2.threw, r2.message)
    check('ideTransaction: corrupt record throws on listTransactions', r3.threw, r3.message)
    check('ideTransaction: corrupt latest.json throws on openTransactionIdFor', r4.threw, r4.message)
    if (POSIX_MODES) {
      const dir2 = makeTempDir('fn14-idetx-perm-')
      const store2 = projectHomeStore(dir2, 'ide-transactions')
      mkdirSync(store2, { recursive: true })
      chmodSync(store2, 0o000)
      try {
        const r5 = throwsMatching(() => listTransactions(dir2), /EACCES|permission/i)
        check('ideTransaction: unreadable store dir throws on listTransactions', r5.threw, r5.message)
      } finally {
        chmodSync(store2, 0o700)
        rmSync(dir2, { recursive: true, force: true })
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { latestRunAtRoot, getRun, listRuns, runPythonTests, testRunsDir } = await import('../../src/services/ide/pythonTests.ts')
  const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.ts')
  const dir = makeTempDir('fn14-pytests-')
  const origPy = process.env.MERCURY_PYTHON
  try {
    check('pythonTests: absent store returns null and empty list', latestRunAtRoot(dir) === null && listRuns(dir).length === 0)
    const runs = testRunsDir(dir)
    mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'latest.json'), '{broken')
    writeFileSync(join(runs, 'run-1-1.json'), '{broken')
    const r1 = throwsMatching(() => latestRunAtRoot(dir), /JSON|parse|corrupt|unexpected/i)
    const r2 = throwsMatching(() => getRun('run-1-1', dir), /JSON|parse|corrupt|unexpected/i)
    const r3 = throwsMatching(() => listRuns(dir), /JSON|parse|corrupt|unexpected/i)
    check('pythonTests: corrupt latest.json throws on latestRunAtRoot', r1.threw, r1.message)
    check('pythonTests: corrupt run file throws on getRun', r2.threw, r2.message)
    check('pythonTests: corrupt run file throws on listRuns', r3.threw, r3.message)
    if (POSIX_MODES) {
      const dir2 = makeTempDir('fn14-pytests-perm-')
      const runs2 = testRunsDir(dir2)
      mkdirSync(runs2, { recursive: true })
      chmodSync(runs2, 0o000)
      try {
        const r4 = throwsMatching(() => listRuns(dir2), /EACCES|permission/i)
        check('pythonTests: unreadable runs dir throws on listRuns', r4.threw, r4.message)
      } finally {
        chmodSync(runs2, 0o700)
        rmSync(dir2, { recursive: true, force: true })
      }
      const fakePy = join(dir, 'fake-python.sh')
      writeFileSync(
        fakePy,
        '#!/bin/sh\nif [ "$1" = "-c" ]; then echo \'{"v":"3.12.0","prefix":"/tmp"}\'; exit 0; fi\nprintf "{corrupt-ndjson\\n" > "$2"\nexit 0\n',
        { mode: 0o755 },
      )
      process.env.MERCURY_PYTHON = fakePy
      _resetPythonProjectForTesting()
      let ndjsonThrew = false
      let ndjsonMsg = '(did not throw)'
      try {
        await runPythonTests({ from: dir, framework: 'unittest' })
      } catch (err) {
        ndjsonMsg = err instanceof Error ? err.message : String(err)
        ndjsonThrew = /JSON|parse|corrupt|unexpected/i.test(ndjsonMsg)
      }
      check('pythonTests: corrupt NDJSON report throws instead of empty events', ndjsonThrew, ndjsonMsg)

      const fakePyGood = join(dir, 'fake-python-good.sh')
      writeFileSync(
        fakePyGood,
        '#!/bin/sh\nif [ "$1" = "-c" ]; then echo \'{"v":"3.12.0","prefix":"/tmp"}\'; exit 0; fi\nprintf \'{"t":"case","id":"t.a","outcome":"passed"}\\n\' > "$2"\nexit 0\n',
        { mode: 0o755 },
      )
      const dirPersist = makeTempDir('fn14-pytests-persist-')
      const blockedRunsDir = testRunsDir(dirPersist)
      mkdirSync(join(blockedRunsDir, '..'), { recursive: true })
      writeFileSync(blockedRunsDir, 'block-dir')
      process.env.MERCURY_PYTHON = fakePyGood
      _resetPythonProjectForTesting()
      let persistThrew = false
      let persistMsg = '(did not throw)'
      try {
        await runPythonTests({ from: dirPersist, framework: 'unittest' })
      } catch (err) {
        persistMsg = err instanceof Error ? err.message : String(err)
        persistThrew = true
      } finally {
        rmSync(blockedRunsDir, { force: true })
        rmSync(dirPersist, { recursive: true, force: true })
      }
      check('pythonTests: persistRun failure throws instead of returning ok', persistThrew, persistMsg)
    }
  } finally {
    if (origPy === undefined) delete process.env.MERCURY_PYTHON
    else process.env.MERCURY_PYTHON = origPy
    _resetPythonProjectForTesting()
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { readUnityTestResults } = await import('../../src/services/ide/unityTests.ts')
  const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.ts')
  const dir = makeTempDir('fn14-unity-')
  try {
    const absent = readUnityTestResults(dir, 'EditMode')
    check('unityTests: absent results file returns absent', absent.state === 'absent', JSON.stringify(absent))
    if (POSIX_MODES) {
      const file = unityTestResultsPath(dir, 'EditMode')
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '<test-run result="Passed"></test-run>')
      chmodSync(file, 0o200)
      try {
        const res = readUnityTestResults(dir, 'EditMode')
        check('unityTests: unreadable results file returns rejected instead of absent', res.state === 'rejected' && /could not be read/i.test(res.reason), JSON.stringify(res))
      } finally {
        chmodSync(file, 0o600)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { readFileSync } = await import('node:fs')
  const { planProjectInstruction, captureProjectInstruction } = await import('../../src/services/instructions/projectInstructionWriter.ts')
  const dir = makeTempDir('fn14-instwriter-')
  try {
    if (POSIX_MODES) {
      const file = join(dir, 'MERCURY.md')
      const original = '# MERCURY.md\n\n- Keep existing standing orders.\n'
      writeFileSync(file, original, { mode: 0o600 })
      chmodSync(file, 0o200)
      try {
        const plan = planProjectInstruction({ cwd: dir, rule: 'Add one more rule.' })
        const cap = captureProjectInstruction({ cwd: dir, rule: 'Add one more rule.' })
        chmodSync(file, 0o600)
        const after = readFileSync(file, 'utf8')
        check(
          'projectInstructionWriter: unreadable target refuses without overwriting',
          !plan.write && plan.result.action === 'invalid' && cap.action === 'invalid' && after === original,
          `plan=${JSON.stringify(plan)} cap=${JSON.stringify(cap)} same=${after === original}`,
        )
      } finally {
        chmodSync(file, 0o600)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { readFileSync } = await import('node:fs')
  const { planLocalServerApply, applyLocalServerPlan } = await import('../../src/services/localServer/localServerApply.ts')
  const dir = makeTempDir('fn14-localapply-')
  try {
    if (POSIX_MODES) {
      const override = join(dir, 'override.conf')
      const original = '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n'
      writeFileSync(override, original, { mode: 0o600 })
      chmodSync(override, 0o200)
      try {
        const truth = {
          server: { kind: 'ollama' as const, root: 'http://127.0.0.1:11434', label: 'Ollama' },
          loaded: [],
          listed: [],
          runners: [],
          launchForm: { kind: 'systemd' as const, path: override, label: 'ollama.service', env: {}, writable: true, note: 'systemd' },
          machine: { platform: 'linux' as const, totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 32 * 1024 ** 3, usableSource: 'test' },
          readAtMs: Date.now(),
        }
        const plan = planLocalServerApply(truth, { parallelSlots: 2 }, { platform: 'linux' })
        check('localServerApply: unreadable systemd override plans by-hand instead of empty write', plan.kind === 'by-hand', JSON.stringify(plan))
        const fakeWritePlan = {
          kind: 'write' as const,
          form: 'systemd' as const,
          path: override,
          backupPath: `${override}.bak`,
          before: '',
          after: '[Service]\nEnvironment="OLLAMA_NUM_PARALLEL=2"\n',
          changes: [{ name: 'OLLAMA_NUM_PARALLEL', after: '2' }],
          lines: ['+Environment="OLLAMA_NUM_PARALLEL=2"'],
          restart: { argv: [], words: '' },
          note: 'test',
        }
        const outcome = await applyLocalServerPlan(fakeWritePlan, { confirmed: true })
        chmodSync(override, 0o600)
        const after = readFileSync(override, 'utf8')
        check(
          'localServerApply: applyLocalServerPlan refuses unreadable override without overwriting',
          outcome.outcome === 'failed' && after === original,
          `outcome=${JSON.stringify(outcome)} same=${after === original}`,
        )
      } finally {
        chmodSync(override, 0o600)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
