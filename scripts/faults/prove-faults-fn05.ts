#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')

const scratchHome = mkdtempSync(join(tmpdir(), 'faults-fn05-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function throwsWithCode(fn: () => unknown, codes: readonly string[]): { threw: boolean; code: string | undefined; message: string } {
  try {
    fn()
    return { threw: false, code: undefined, message: '' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { threw: true, code, message: error instanceof Error ? error.message : String(error) }
  }
}

{
  const { hashTree, treeFileDigests, folderSize } = await import('../../src/extensions/tree.ts')
  const dir = mkdtempSync(join(tmpdir(), 'faults-fn05-tree-'))
  try {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'root.txt'), 'root')
    writeFileSync(join(dir, 'sub', 'hidden.txt'), 'secret')
    if (POSIX_MODES) {
      chmodSync(join(dir, 'sub'), 0o000)
      try {
        const hashRes = throwsWithCode(() => hashTree(dir), ['EACCES', 'EPERM'])
        const digestsRes = throwsWithCode(() => treeFileDigests(dir), ['EACCES', 'EPERM'])
        const size = folderSize(dir)
        check('tree: hashTree throws on unreadable subfolder', hashRes.threw && (hashRes.code === 'EACCES' || hashRes.code === 'EPERM'), JSON.stringify(hashRes))
        check('tree: treeFileDigests throws on unreadable subfolder', digestsRes.threw && (digestsRes.code === 'EACCES' || digestsRes.code === 'EPERM'), JSON.stringify(digestsRes))
        check('tree: folderSize stays best-effort on unreadable subfolder', size === 4, String(size))
      } finally {
        chmodSync(join(dir, 'sub'), 0o700)
      }
    }
    const missingHash = hashTree(join(dir, 'absent'))
    check('tree: hashTree still treats missing root as empty', missingHash.startsWith('sha256:'), missingHash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { generatedAssetsRefusal } = await import('../../src/guards/commitGate.ts')
  const { GENERATED_ASSETS_MAP } = await import('../../src/guards/generatedAssets.ts')
  const repo = mkdtempSync(join(tmpdir(), 'faults-fn05-commitgate-'))
  try {
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' } })
    }
    git('init')
    mkdirSync(join(repo, 'scripts/gate'), { recursive: true })
    writeFileSync(join(repo, GENERATED_ASSETS_MAP), 'out.txt\tgen.ts\t-\tre:TRIGGER_TOKEN\n')
    writeFileSync(join(repo, 'src.txt'), 'initial\n')
    writeFileSync(join(repo, 'out.txt'), 'out\n')
    git('add', '.')
    git('commit', '-m', 'init')
    writeFileSync(join(repo, 'src.txt'), 'TRIGGER_TOKEN\n')
    git('add', 'src.txt')
    if (POSIX_MODES) {
      chmodSync(join(repo, 'src.txt'), 0o000)
      try {
        let threw = false
        let refusal: string | null = null
        try {
          refusal = generatedAssetsRefusal('git commit -m "upd" -- src.txt', repo)
        } catch {
          threw = true
        }
        check('commitGate: unreadable commit candidate refuses instead of passing open', threw || refusal !== null, `threw=${threw} refusal=${String(refusal)}`)
      } finally {
        chmodSync(join(repo, 'src.txt'), 0o600)
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

{
  const { engageToolGuard, judgeToolCall, resetGuardsForTesting } = await import('../../src/guards/guards.ts')
  resetGuardsForTesting()
  engageToolGuard('fn05-throw', {
    id: 'throwing-guard',
    judge: () => {
      throw new Error('guard exploded')
    },
  })
  const threwVerdict = await judgeToolCall('fn05-throw', { tool: 'Bash', input: { command: 'rm -rf /' }, callId: 'c1', messages: [] })
  check('guards: judgeToolCall refuses when a tool guard throws', threwVerdict.refused === true && threwVerdict.guard === 'throwing-guard', JSON.stringify(threwVerdict))
  engageToolGuard('fn05-timeout', {
    id: 'slow-guard',
    timeoutMs: 25,
    judge: () => new Promise(() => {}),
  })
  const timeoutVerdict = await judgeToolCall('fn05-timeout', { tool: 'Bash', input: { command: 'echo hi' }, callId: 'c2', messages: [] })
  check('guards: judgeToolCall refuses when a tool guard times out', timeoutVerdict.refused === true && timeoutVerdict.guard === 'slow-guard', JSON.stringify(timeoutVerdict))
  resetGuardsForTesting()
}

function runIsolated(body: string): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'faults-fn05-iso-'))
  try {
    const src = `
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      const out = {}
      ${body}
      process.stdout.write('\\n' + JSON.stringify(out))
      process.exit(0)
    `
    const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
    if (res.status !== 0) throw new Error(`isolated failed: ${res.stderr.slice(-1000)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const statePath = ${JSON.stringify(join(SRC, 'bootstrap/state.ts'))}
    const realState = await import(statePath)
    mock.module(statePath, () => ({
      ...realState,
      getIsInteractive: () => { throw new Error('bootstrap boom') },
      getSessionId: () => { throw new Error('session boom') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'guards/runStopAdapter.ts'))})
    try {
      mod.headlessMintAllowed(undefined)
      out.headlessThrew = false
    } catch (e) {
      out.headlessThrew = e instanceof Error && e.message === 'bootstrap boom'
    }
    try {
      await mod.evaluateStopAttempt([], { maxBlocks: 1, wordingUnfinished: false })
      out.evalThrew = false
    } catch (e) {
      out.evalThrew = e instanceof Error && e.message === 'bootstrap boom'
    }
  `)
  check('runStopAdapter: headlessMintAllowed lets getIsInteractive throw', r.headlessThrew === true, JSON.stringify(r))
  check('runStopAdapter: evaluateStopAttempt lets getIsInteractive throw', r.evalThrew === true, JSON.stringify(r))
}

{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const missionPath = ${JSON.stringify(join(SRC, 'guards/mission.ts'))}
    const realMission = await import(missionPath)
    mock.module(missionPath, () => ({
      ...realMission,
      getActiveMission: () => { throw new Error('mission boom') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'guards/runStopAdapter.ts'))})
    try {
      await mod.evaluateStopAttempt([], { maxBlocks: 1, wordingUnfinished: false })
      out.evalThrew = false
    } catch (e) {
      out.evalThrew = e instanceof Error && e.message === 'mission boom'
    }
  `)
  check('runStopAdapter: evaluateStopAttempt lets getActiveMission throw', r.evalThrew === true, JSON.stringify(r))
}

{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const statePath = ${JSON.stringify(join(SRC, 'bootstrap/state.ts'))}
    const realState = await import(statePath)
    mock.module(statePath, () => ({
      ...realState,
      getIsInteractive: () => true,
      getSessionId: () => { throw new Error('session boom') },
    }))
    let mintedWith = null
    const wtPath = ${JSON.stringify(join(SRC, 'services/walkthrough/assembleWalkthrough.ts'))}
    const realWt = await import(wtPath)
    mock.module(wtPath, () => ({
      ...realWt,
      createWalkthroughArtifact: (args) => { mintedWith = args; return { ok: true, value: { version: 1 } } },
    }))
    const events = []
    const coordPath = ${JSON.stringify(join(SRC, 'services/run/runCoordinator.ts'))}
    const realCoord = await import(coordPath)
    mock.module(coordPath, () => ({
      ...realCoord,
      noteRunEvent: (_owner, ev) => { events.push(ev) },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'guards/runStopAdapter.ts'))})
    mod.mintDeliveryArtifact('owner-1', 'run-1', true)
    const deadline = Date.now() + 2000
    while (events.length === 0 && mintedWith === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    out.mintedWith = mintedWith
    out.events = events
  `)
  const events = (r.events as Array<{ action?: string }>) ?? []
  check('runStopAdapter: mintDeliveryArtifact reports getSessionId failure instead of unknown-session', r.mintedWith === null && events.some(e => typeof e.action === 'string' && e.action.includes('session boom')), JSON.stringify(r))
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
