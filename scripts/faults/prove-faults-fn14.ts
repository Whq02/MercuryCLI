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
const faultHints: Array<[string, string]> = [
  ['godotSession:', 'change parseGodotProjectFile in src/integrations/ide/godotSession.ts to return empty only when project.godot is absent and throw on any other read error'],
  ['ideTransaction:', 'change latestTransaction, getTransaction, listTransactions or openTransactionIdFor in src/integrations/ide/ideTransaction.ts to treat only an absent store as empty and throw on corrupt or unreadable files'],
  ['pythonTests:', 'change latestRunAtRoot, getRun, listRuns or runPythonTests in src/integrations/ide/pythonTests.ts to treat only absent files as empty, throw on unreadable or corrupt ones, and note an unsaved run in verdictNote'],
  ['unityTests:', 'change readUnityTestResults in src/integrations/ide/unityTests.ts to return absent only when the results file is missing and rejected when it cannot be read'],
  ['projectInstructionWriter:', 'change planProjectInstruction and captureProjectInstruction in src/sessions/instructions/projectInstructionWriter.ts to refuse as invalid when the target cannot be read, never overwriting it'],
  ['localServerApply:', 'change planLocalServerApply or applyLocalServerPlan in src/models/local-server/localServerApply.ts to plan by hand or return stale when the systemd override cannot be read'],
  ['localServerTruth:', 'change readLocalMachineTruth in src/models/local-server/localServerTruth.ts to report the launch form as unknown (the launch form could not be read) when its file or folder cannot be read'],
  ['ggufServers:', 'change ggufServerRoots, rememberGgufServer or forgetGgufServer in src/models/local-setup/ggufServers.ts to heal a torn list and refuse to overwrite an unreadable one'],
  ['projectRunners:', 'change detectPackageManager or runRunnerProfile in src/integrations/ide/projectRunners.ts to name a package.json read failure and a lost output artifact in the verdict'],
]
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = cond ? '' : (faultHints.find(([prefix]) => label.startsWith(prefix))?.[1] ?? '')
  const said = [detail, hint].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && said ? ` — ${said}` : ''}`)
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
  const { parseGodotProjectFile, _resetGodotSessionForTesting } = await import('../../src/integrations/ide/godotSession.ts')
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
  const { getTransaction, latestTransaction, listTransactions, openTransactionIdFor } = await import('../../src/integrations/ide/ideTransaction.ts')
  const { projectHomeStore } = await import('../../src/platform/storage/projectHomeStores.ts')
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
  const { latestRunAtRoot, getRun, listRuns, runPythonTests, testRunsDir } = await import('../../src/integrations/ide/pythonTests.ts')
  const { _resetPythonProjectForTesting } = await import('../../src/integrations/ide/pythonProject.ts')
  const dir = makeTempDir('fn14-pytests-')
  const origPy = process.env.MERCURY_PYTHON
  try {
    check('pythonTests: absent store returns null and empty list', latestRunAtRoot(dir) === null && listRuns(dir).length === 0)
    const runs = testRunsDir(dir)
    mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'latest.json'), '{broken')
    writeFileSync(join(runs, 'run-1-1.json'), '{broken')
    writeFileSync(join(runs, 'run-2-1.json'), JSON.stringify({ id: 'run-2-1', startedAt: 2, counts: { passed: 1, failed: 0, skipped: 0, errored: 0 } }))
    const r1 = throwsMatching(() => latestRunAtRoot(dir), /JSON|parse|corrupt|unexpected/i)
    const r2 = throwsMatching(() => getRun('run-1-1', dir), /JSON|parse|corrupt|unexpected/i)
    const listed = listRuns(dir)
    check('pythonTests: corrupt latest.json throws on latestRunAtRoot', r1.threw, r1.message)
    check('pythonTests: corrupt run file throws on getRun', r2.threw, r2.message)
    check('pythonTests: corrupt run file is skipped without hiding valid runs in listRuns', listed.length === 1 && listed[0]?.id === 'run-2-1', JSON.stringify(listed))
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
      const fakePyUnreadable = join(dir, 'fake-python-unreadable.sh')
      writeFileSync(
        fakePyUnreadable,
        '#!/bin/sh\nif [ "$1" = "-c" ]; then echo \'{"v":"3.12.0","prefix":"/tmp"}\'; exit 0; fi\nprintf \'{"t":"case","id":"t.a","outcome":"passed"}\\n\' > "$2"\nchmod 200 "$2"\nexit 0\n',
        { mode: 0o755 },
      )
      process.env.MERCURY_PYTHON = fakePyUnreadable
      _resetPythonProjectForTesting()
      let ndjsonThrew = false
      let ndjsonMsg = '(did not throw)'
      try {
        await runPythonTests({ from: dir, framework: 'unittest' })
      } catch (err) {
        ndjsonMsg = err instanceof Error ? err.message : String(err)
        ndjsonThrew = /EACCES|permission/i.test(ndjsonMsg)
      }
      check('pythonTests: unreadable NDJSON report throws instead of empty events', ndjsonThrew, ndjsonMsg)

      const fakePyTruncated = join(dir, 'fake-python-trunc.sh')
      writeFileSync(
        fakePyTruncated,
        '#!/bin/sh\nif [ "$1" = "-c" ]; then echo \'{"v":"3.12.0","prefix":"/tmp"}\'; exit 0; fi\nprintf \'{"t":"case","id":"t.a","outcome":"passed"}\\n{truncated\' > "$2"\nexit 0\n',
        { mode: 0o755 },
      )
      const dirPersist = makeTempDir('fn14-pytests-persist-')
      const blockedRunsDir = testRunsDir(dirPersist)
      mkdirSync(join(blockedRunsDir, '..'), { recursive: true })
      writeFileSync(blockedRunsDir, 'block-dir')
      process.env.MERCURY_PYTHON = fakePyTruncated
      _resetPythonProjectForTesting()
      try {
        const out = await runPythonTests({ from: dirPersist, framework: 'unittest' })
        check(
          'pythonTests: truncated NDJSON line skipped and failed persistRun noted in verdictNote',
          out.state === 'ok' &&
            out.record.counts.passed === 1 &&
            Boolean(out.record.verdictNote?.includes('this test run could not be saved (')) &&
            Boolean(out.record.verdictNote?.includes('rerunFailed and report will not see it')),
          out.state === 'ok' ? JSON.stringify({ counts: out.record.counts, verdictNote: out.record.verdictNote }) : JSON.stringify(out),
        )
      } finally {
        rmSync(blockedRunsDir, { force: true })
        rmSync(dirPersist, { recursive: true, force: true })
      }
    }
  } finally {
    if (origPy === undefined) delete process.env.MERCURY_PYTHON
    else process.env.MERCURY_PYTHON = origPy
    _resetPythonProjectForTesting()
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { readUnityTestResults } = await import('../../src/integrations/ide/unityTests.ts')
  const { unityTestResultsPath } = await import('../../src/integrations/unity-protocol/unityProject.ts')
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
        check('unityTests: unreadable results file returns rejected instead of absent', res.state === 'rejected' && /EACCES|permission/i.test(res.reason), JSON.stringify(res))
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
  const { planProjectInstruction, captureProjectInstruction } = await import('../../src/sessions/instructions/projectInstructionWriter.ts')
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
  const { planLocalServerApply, applyLocalServerPlan } = await import('../../src/models/local-server/localServerApply.ts')
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
        const seamPlan = planLocalServerApply(truth, { parallelSlots: 2 }, { platform: 'linux', readText: () => undefined, pathExists: () => true })
        const plan = planLocalServerApply(truth, { parallelSlots: 2 }, { platform: 'linux' })
        check('localServerApply: unreadable systemd override plans by-hand instead of empty write', seamPlan.kind === 'by-hand' && plan.kind === 'by-hand', JSON.stringify({ seamPlan: seamPlan.kind, plan: plan.kind }))
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
          'localServerApply: applyLocalServerPlan returns stale on unreadable override without overwriting',
          outcome.outcome === 'stale' && after === original,
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

{
  const { readLocalMachineTruth, HOMEBREW_OLLAMA_PLIST } = await import('../../src/models/local-server/localServerTruth.ts')
  const probeEnv = { MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:11434' }
  const linuxTruth = await readLocalMachineTruth({
    env: probeEnv,
    platform: 'linux',
    pathExists: () => true,
    readText: () => undefined,
    run: async () => undefined,
  }, 'ollama')
  check(
    'localServerTruth: unreadable systemd override reports unreadable launch form instead of empty env',
    linuxTruth.launchForm.kind === 'unknown' && linuxTruth.launchForm.note === 'the launch form could not be read',
    JSON.stringify(linuxTruth.launchForm),
  )
  if (POSIX_MODES) {
    const home1 = makeTempDir('fn14-truth-dir-')
    const agents1 = join(home1, 'Library', 'LaunchAgents')
    mkdirSync(agents1, { recursive: true })
    chmodSync(agents1, 0o000)
    try {
      const t1 = await readLocalMachineTruth({ env: probeEnv, platform: 'darwin', home: home1, run: async () => undefined }, 'ollama')
      check(
        'localServerTruth: unreadable LaunchAgents dir reports unreadable launch form instead of absent',
        t1.launchForm.kind === 'unknown' && t1.launchForm.note === 'the launch form could not be read',
        JSON.stringify(t1.launchForm),
      )
    } finally {
      chmodSync(agents1, 0o700)
      rmSync(home1, { recursive: true, force: true })
    }
    const home2 = makeTempDir('fn14-truth-plist-')
    const agents2 = join(home2, 'Library', 'LaunchAgents')
    mkdirSync(agents2, { recursive: true })
    const plist = join(agents2, HOMEBREW_OLLAMA_PLIST)
    writeFileSync(plist, '<plist></plist>', { mode: 0o600 })
    chmodSync(plist, 0o200)
    try {
      const t2 = await readLocalMachineTruth({ env: probeEnv, platform: 'darwin', home: home2, run: async () => undefined }, 'ollama')
      check(
        'localServerTruth: unreadable ollama plist reports unreadable launch form instead of absent',
        t2.launchForm.kind === 'unknown' && t2.launchForm.note === 'the launch form could not be read',
        JSON.stringify(t2.launchForm),
      )
    } finally {
      chmodSync(plist, 0o600)
      rmSync(home2, { recursive: true, force: true })
    }
  }
}

{
  const { readFileSync } = await import('node:fs')
  const { ggufServerRoots, rememberGgufServer, forgetGgufServer } = await import('../../src/models/local-setup/ggufServers.ts')
  const regDir = join(scratchHome, 'local-setup')
  const regFile = join(regDir, 'gguf-servers.json')
  mkdirSync(regDir, { recursive: true })
  try {
    const torn = '{corrupt-gguf-registry'
    writeFileSync(regFile, torn, { mode: 0o600 })
    const rRead = ggufServerRoots()
    rememberGgufServer('http://127.0.0.1:8082')
    const afterHeal = ggufServerRoots()
    check(
      'ggufServers: torn list is healed by next remember',
      rRead.length === 0 && afterHeal.length === 1 && afterHeal[0] === 'http://127.0.0.1:8082',
      `read=${JSON.stringify(rRead)} afterHeal=${JSON.stringify(afterHeal)}`,
    )
    if (POSIX_MODES) {
      const saved = '["http://127.0.0.1:8081"]\n'
      writeFileSync(regFile, saved, { mode: 0o600 })
      chmodSync(regFile, 0o200)
      try {
        const uRead = ggufServerRoots()
        const uRem = throwsMatching(() => rememberGgufServer('http://127.0.0.1:8082'), /EACCES|permission/i)
        const uFgt = throwsMatching(() => forgetGgufServer('http://127.0.0.1:8081'), /EACCES|permission/i)
        chmodSync(regFile, 0o600)
        check(
          'ggufServers: unreadable registry keeps reader empty and refuses remember/forget without overwriting',
          uRead.length === 0 && uRem.threw && uFgt.threw && readFileSync(regFile, 'utf8') === saved,
          `read=${JSON.stringify(uRead)} rem=${uRem.message} fgt=${uFgt.message}`,
        )
      } finally {
        chmodSync(regFile, 0o600)
      }
    }
  } finally {
    rmSync(regFile, { force: true })
  }
}

{
  const { detectPackageManager, runRunnerProfile } = await import('../../src/integrations/ide/projectRunners.ts')
  const dir = makeTempDir('fn14-runners-')
  const artifactsRoot = join(scratchHome, 'artifacts')
  const testArtifactsBlocker = join(artifactsRoot, 'test')
  try {
    writeFileSync(join(dir, 'package.json'), '{broken-json')
    const pm = detectPackageManager(dir)
    check(
      'projectRunners: corrupt package.json reports read failure in detectPackageManager',
      'missing' in pm && pm.missing.includes('package.json could not be read (') && pm.missing.includes('fix it or declare a lockfile'),
      JSON.stringify(pm),
    )
    mkdirSync(artifactsRoot, { recursive: true })
    writeFileSync(testArtifactsBlocker, 'block-mkdir')
    const profile = {
      id: 'rp-fn14-test',
      runner: 'node-test' as const,
      kind: 'test' as const,
      title: 'node --test',
      source: 'package.json',
      root: dir,
      command: [process.execPath, '-e', 'for (let i = 0; i < 60; i++) console.log("line " + i); console.log("# tests 1\\n# pass 1\\n# fail 0")'],
      selection: 'none' as const,
      availability: { state: 'ok' as const },
    }
    const outcome = await runRunnerProfile(profile, { from: dir })
    check(
      'projectRunners: failed artifact store notes lost output in verdictNote',
      outcome.state === 'ok' &&
        outcome.record.outputArtifactRef === undefined &&
        Boolean(outcome.record.verdictNote?.includes('could not be saved')) &&
        Boolean(outcome.record.verdictNote?.includes('only the last 40 lines were kept')),
      outcome.state === 'ok' ? JSON.stringify(outcome.record.verdictNote) : JSON.stringify(outcome),
    )
  } finally {
    rmSync(testArtifactsBlocker, { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
