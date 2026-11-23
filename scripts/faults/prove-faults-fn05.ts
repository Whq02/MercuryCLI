#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')

const scratchHome = mkdtempSync(join(tmpdir(), 'faults-fn05-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const AREA_FIX_HINTS: Record<string, string> = {
  tree: 'fix hashTree, treeFileDigests or folderSize in src/integrations/extensions/tree.ts so an unreadable subfolder is marked, not skipped silently',
  commitGate: 'fix generatedAssetsRefusal in src/permissions/guards/commitGate.ts so an unreadable candidate file does not refuse the commit',
  guards: 'fix judgeToolCall in src/permissions/guards/guards.ts so a throwing or timed-out tool guard lets the call go on with one note',
  runStopAdapter: 'fix headlessMintAllowed, evaluateStopAttempt or mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts',
  wardsGuard: 'fix src/permissions/guards/wardsGuard.ts (registerWardsGuard, realTargetPath, makeTargetResolver or homeSpellings)',
  history: 'fix historyPasteHashes in src/sessions/promptHistory.ts so an unreadable history.jsonl rejects instead of answering empty',
  useAuthWallHold: 'fix afterDoor in src/screen/chat/useAuthWallHold.ts so a failed sign-in refresh notifies the user',
  useExtensions: 'fix src/screen/extensions/useExtensions.ts so a failed boot load clears pending and notifies the user',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = AREA_FIX_HINTS[label.split(':')[0] ?? '']
  const shown = !cond ? [detail, hint].filter(Boolean).join(' | ') : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

{
  const { hashTree, treeFileDigests, folderSize } = await import('../../src/integrations/extensions/tree.ts')
  const dir = mkdtempSync(join(tmpdir(), 'faults-fn05-tree-'))
  const withoutSub = mkdtempSync(join(tmpdir(), 'faults-fn05-tree-nosub-'))
  try {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'root.txt'), 'root')
    writeFileSync(join(dir, 'sub', 'hidden.txt'), 'secret')
    writeFileSync(join(withoutSub, 'root.txt'), 'root')
    const readableHash = hashTree(dir)
    const noSubHash = hashTree(withoutSub)
    const readableDigests = treeFileDigests(dir)
    const noSubDigests = treeFileDigests(withoutSub)
    if (POSIX_MODES) {
      chmodSync(join(dir, 'sub'), 0o000)
      try {
        const unreadableHash = hashTree(dir)
        const unreadableDigests = treeFileDigests(dir)
        const size = folderSize(dir)
        check('tree: hashTree with unreadable subfolder differs from readable tree and from tree without subfolder', unreadableHash !== readableHash && unreadableHash !== noSubHash, `${unreadableHash} vs ${readableHash} vs ${noSubHash}`)
        check('tree: treeFileDigests records unreadable subfolder marker', unreadableDigests['sub/'] === '<unreadable-dir>' && JSON.stringify(unreadableDigests) !== JSON.stringify(readableDigests) && JSON.stringify(unreadableDigests) !== JSON.stringify(noSubDigests), JSON.stringify(unreadableDigests))
        check('tree: folderSize stays best-effort on unreadable subfolder', size === 4, String(size))
      } finally {
        chmodSync(join(dir, 'sub'), 0o700)
      }
    }
    const missingHash = hashTree(join(dir, 'absent'))
    const emptyDir = mkdtempSync(join(tmpdir(), 'faults-fn05-tree-empty-'))
    try {
      check('tree: hashTree still treats missing root same as empty folder', missingHash === hashTree(emptyDir), missingHash)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(withoutSub, { recursive: true, force: true })
  }
}

{
  const { generatedAssetsRefusal } = await import('../../src/permissions/guards/commitGate.ts')
  const { GENERATED_ASSETS_MAP } = await import('../../src/permissions/guards/generatedAssets.ts')
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
        check('commitGate: a commit candidate that cannot be read does not refuse the commit', !threw && refusal === null, `threw=${threw} refusal=${String(refusal)}`)
      } finally {
        chmodSync(join(repo, 'src.txt'), 0o600)
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

{
  const { engageToolGuard, judgeToolCall, resetGuardsForTesting } = await import('../../src/permissions/guards/guards.ts')
  resetGuardsForTesting()
  engageToolGuard('fn05-throw', {
    id: 'throwing-guard',
    judge: () => {
      throw new Error('guard exploded')
    },
  })
  const threwVerdict = await judgeToolCall('fn05-throw', { tool: 'Bash', input: { command: 'rm -rf /' }, callId: 'c1', messages: [] })
  const threwAgain = await judgeToolCall('fn05-throw', { tool: 'Bash', input: { command: 'ls' }, callId: 'c1b', messages: [] })
  check(
    'guards: a tool guard that throws lets the call go on and says so once',
    threwVerdict.refused === false &&
      JSON.stringify(threwVerdict.notes).includes('One check of this Bash call could not be completed (guard exploded), so this call and any later one it cannot finish run without it.') &&
      threwAgain.refused === false &&
      threwAgain.notes.length === 0,
    JSON.stringify([threwVerdict, threwAgain]),
  )
  engageToolGuard('fn05-timeout', {
    id: 'slow-guard',
    timeoutMs: 25,
    judge: () => new Promise(() => {}),
  })
  const timeoutVerdict = await judgeToolCall('fn05-timeout', { tool: 'Bash', input: { command: 'echo hi' }, callId: 'c2', messages: [] })
  check('guards: a tool guard cut at its time limit lets the call go on and says so once', timeoutVerdict.refused === false && timeoutVerdict.notes.length === 1 && JSON.stringify(timeoutVerdict.notes).includes('(the guard was cut)'), JSON.stringify(timeoutVerdict))
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
    const statePath = ${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))}
    const realState = await import(statePath)
    mock.module(statePath, () => ({
      ...realState,
      getIsInteractive: () => { throw new Error('bootstrap boom') },
      getSessionId: () => { throw new Error('session boom') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'permissions/guards/runStopAdapter.ts'))})
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
    const missionPath = ${JSON.stringify(join(SRC, 'permissions/guards/mission.ts'))}
    const realMission = await import(missionPath)
    mock.module(missionPath, () => ({
      ...realMission,
      getActiveMission: () => { throw new Error('mission boom') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'permissions/guards/runStopAdapter.ts'))})
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
    const statePath = ${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))}
    const realState = await import(statePath)
    mock.module(statePath, () => ({
      ...realState,
      getIsInteractive: () => true,
      getSessionId: () => { throw new Error('session boom') },
    }))
    let mintedWith = null
    const wtPath = ${JSON.stringify(join(SRC, 'sessions/walkthrough/assembleWalkthrough.ts'))}
    const realWt = await import(wtPath)
    mock.module(wtPath, () => ({
      ...realWt,
      createWalkthroughArtifact: (args) => { mintedWith = args; return { ok: true, value: { version: 1 } } },
    }))
    const events = []
    const coordPath = ${JSON.stringify(join(SRC, 'engine/run/runCoordinator.ts'))}
    const realCoord = await import(coordPath)
    mock.module(coordPath, () => ({
      ...realCoord,
      noteRunEvent: (_owner, ev) => { events.push(ev) },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'permissions/guards/runStopAdapter.ts'))})
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

{
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    process.env.MERCURY_WARDS = 'enforce'
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'faults-fn05-wards-')))
    try {
      fs.mkdirSync(path.join(repo, '.git'))
      fs.mkdirSync(path.join(repo, 'src/components'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'src/screen/theme/mercuryPalette.ts'), 'export const x = 1\\n')
      fs.writeFileSync(path.join(repo, 'package.json'), '{ corrupt json')
      fs.writeFileSync(path.join(repo, 'src/components/a.tsx'), 'export const a = 1\\n')
      try {
        fs.symlinkSync(path.join(repo, 'loop-b'), path.join(repo, 'loop-a'))
        fs.symlinkSync(path.join(repo, 'loop-a'), path.join(repo, 'loop-b'))
      } catch (e) {
        if (process.platform === 'win32' && e?.code === 'EPERM') {
          out.loopNoSymlink = true
        } else {
          throw e
        }
      }
      process.chdir(repo)
      const guardsMod = await import(${JSON.stringify(join(SRC, 'permissions/guards/guards.ts'))})
      const wardsGuard = await import(${JSON.stringify(join(SRC, 'permissions/guards/wardsGuard.ts'))})
      guardsMod.resetGuardsForTesting()
      wardsGuard.resetWardsEngagedSessionsForTest()
      wardsGuard.registerWardsGuard(() => {}, 'wards-fn05')
      out.throwVerdict = await guardsMod.judgeToolCall('wards-fn05', {
        tool: 'Edit',
        input: { file_path: path.join(repo, 'src/components/a.tsx'), old_string: '1', new_string: '2' },
        callId: 'w1',
        messages: [],
        toolRef: { name: 'Edit', shellCommandOf: () => { throw new Error('boom-in-ward') } },
      })
      out.throwAgain = await guardsMod.judgeToolCall('wards-fn05', {
        tool: 'Edit',
        input: { file_path: path.join(repo, 'src/components/a.tsx'), old_string: '1', new_string: '2' },
        callId: 'w1b',
        messages: [],
        toolRef: { name: 'Edit', shellCommandOf: () => { throw new Error('boom-in-ward') } },
      })
      out.badPkgVerdict = await guardsMod.judgeToolCall('wards-fn05', {
        tool: 'Edit',
        input: { file_path: path.join(repo, 'src/components/a.tsx'), old_string: '1', new_string: 'const c = "#ff0000"' },
        callId: 'w2',
        messages: [],
      })
      out.unreadPkgVerdict = null
      if (${POSIX_MODES}) {
        fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"mercury"}')
        fs.chmodSync(path.join(repo, 'package.json'), 0o000)
        out.unreadPkgVerdict = await guardsMod.judgeToolCall('wards-fn05', {
          tool: 'Edit',
          input: { file_path: path.join(repo, 'src/components/a.tsx'), old_string: '1', new_string: 'const c = "#ff0000"' },
          callId: 'w3',
          messages: [],
        })
        fs.chmodSync(path.join(repo, 'package.json'), 0o644)
      }
      out.loopThrew = false
      if (!out.loopNoSymlink) {
        try {
          wardsGuard.realTargetPath(path.join(repo, 'loop-a'))
        } catch {
          out.loopThrew = true
        }
      }
      out.nulThrew = false
      try {
        wardsGuard.makeTargetResolver(repo)('bad\\0path')
      } catch {
        out.nulThrew = true
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  `)
  const throwV = r.throwVerdict as { refused?: boolean; notes?: unknown[] }
  const throwAgain = r.throwAgain as { refused?: boolean; notes?: unknown[] }
  const badPkgV = r.badPkgVerdict as { refused?: boolean; reason?: string }
  check(
    'wardsGuard: a judge that throws lets the call go on and says so once',
    throwV?.refused === false &&
      JSON.stringify(throwV.notes).includes('The wards could not check this Edit call (boom-in-ward), so this call and any later one they cannot check run without them.') &&
      throwAgain?.refused === false &&
      throwAgain.notes?.length === 0,
    JSON.stringify([throwV, throwAgain]),
  )
  const unreadPkgV = r.unreadPkgVerdict as { refused?: boolean; reason?: string } | null
  check('wardsGuard: a package.json that does not parse cannot identify Mercury, so the call is not refused', badPkgV?.refused === false, JSON.stringify(badPkgV))
  if (POSIX_MODES) check('wardsGuard: a package.json that cannot be read cannot identify Mercury, so the call is not refused', unreadPkgV?.refused === false, JSON.stringify(unreadPkgV))
  if (r.loopNoSymlink === true) skip('wardsGuard: a symlink loop is judged as a path not made yet, with no throw', 'not read on Windows: no symlink privilege')
  else check('wardsGuard: a symlink loop is judged as a path not made yet, with no throw', r.loopThrew === false, JSON.stringify(r))
  check('wardsGuard: a path that cannot be expanded is judged by its own spelling, with no throw', r.nulThrew === false, JSON.stringify(r))
}

{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const pathModPath = ${JSON.stringify(join(SRC, 'platform/files/path.ts'))}
    const realPathMod = await import(pathModPath)
    mock.module(pathModPath, () => ({
      ...realPathMod,
      expandPath: () => { throw new Error('home boom') },
    }))
    const wardsGuard = await import(${JSON.stringify(join(SRC, 'permissions/guards/wardsGuard.ts'))})
    try {
      out.spellings = wardsGuard.homeSpellings()
      out.threw = false
    } catch (e) {
      out.threw = true
    }
  `)
  check('wardsGuard: a home folder that cannot be told answers no spellings, with no throw', r.threw === false && Array.isArray(r.spellings) && (r.spellings as unknown[]).length === 0, JSON.stringify(r))
}

if (POSIX_MODES) {
  const r = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const historyMod = await import(${JSON.stringify(join(SRC, 'sessions/promptHistory.ts'))})
    const empty = await historyMod.historyPasteHashes()
    out.absentSize = empty.size
    const histFile = path.join(process.env.MERCURY_CONFIG_DIR, 'history.jsonl')
    fs.writeFileSync(histFile, JSON.stringify({ display: 'hi', pastedContents: { 1: { id: 1, type: 'text', contentHash: 'abc123' } }, timestamp: 1, project: '/' }) + '\\n')
    fs.chmodSync(histFile, 0o000)
    try {
      await historyMod.historyPasteHashes()
      out.unreadableThrew = false
    } catch (e) {
      out.unreadableThrew = e && (e.code === 'EACCES' || e.code === 'EPERM')
    } finally {
      fs.chmodSync(histFile, 0o600)
    }
  `)
  check('history: historyPasteHashes rejects when history.jsonl is unreadable instead of answering empty', r.absentSize === 0 && r.unreadableThrew === true, JSON.stringify(r))
}

{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const { EventEmitter: NodeEventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')
    const { createElement } = await import('react')
    process.env.NODE_ENV = 'test'
    const authPath = ${JSON.stringify(join(SRC, 'models/sign-in/lifecycle/oauthLifecycle.ts'))}
    const realAuth = await import(authPath)
    mock.module(authPath, () => ({
      ...realAuth,
      invalidateOnDiskChange: () => { throw new Error('config unreadable') },
    }))
    const { useAuthWallHold } = await import(${JSON.stringify(join(SRC, 'screen/chat/useAuthWallHold.ts'))})
    const { AppStoreContext, getDefaultAppState } = await import(${JSON.stringify(join(SRC, 'screen/app-state/AppState.tsx'))})
    const { createStore } = await import(${JSON.stringify(join(SRC, 'platform/primitives/store.ts'))})
    const { default: StdinContext } = await import(${JSON.stringify(join(SRC, 'screen/renderer/elements/StdinContext.ts'))})
    const { Box, EventEmitter, render, flushPendingSyncWork } = await import(${JSON.stringify(join(SRC, 'screen/themedRenderer.ts'))})
    const store = createStore(getDefaultAppState())
    let handle = null
    let composerText = ''
    const messages = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello world' } },
      { type: 'assistant', uuid: 'e1', isApiErrorMessage: true, error: 'authentication_failed', message: { role: 'assistant', content: [] } },
    ]
    function Probe() {
      handle = useAuthWallHold(messages, { text: () => composerText, restore: t => { composerText = t } }, () => 'claude-opus-4-6')
      return null
    }
    const emitter = new EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns: 80, rows: 24 })
    const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const inst = await render(
      createElement(AppStoreContext.Provider, { value: store },
        createElement(StdinContext.Provider, { value: stdinValue },
          createElement(Box, null, createElement(Probe)))),
      { stdin, stdout, patchConsole: false, exitOnCtrlC: false },
    )
    for (let i = 0; i < 4; i++) { flushPendingSyncWork(); await new Promise(res => setTimeout(res, 10)) }
    let resent = false
    handle.afterDoor('logins', () => { resent = true })
    for (let i = 0; i < 4; i++) { flushPendingSyncWork(); await new Promise(res => setTimeout(res, 10)) }
    const n = store.getState().notifications
    const all = [...(n.current ? [n.current] : []), ...n.queue]
    out.resent = resent
    out.texts = all.map(item => item.text).filter(Boolean)
    inst.unmount()
    inst.cleanup()
    stream.destroy()
  `)
  const texts = (r.texts as string[]) ?? []
  check('useAuthWallHold: notifies user when sign-in state refresh throws in afterDoor', r.resent === false && texts.some(t => t === 'Sign-in state could not be refreshed (config unreadable) — press Enter to send your prompt.'), JSON.stringify(r))
}

{
  const r = runIsolated(`
    const { mock } = await import('bun:test')
    const { EventEmitter: NodeEventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')
    const { createElement } = await import('react')
    process.env.NODE_ENV = 'test'
    const bootPath = ${JSON.stringify(join(SRC, 'integrations/extensions/boot.ts'))}
    const realBoot = await import(bootPath)
    mock.module(bootPath, () => ({
      ...realBoot,
      ensureExtensionsLoaded: async () => { throw new Error('disk offline') },
    }))
    const { useExtensions } = await import(${JSON.stringify(join(SRC, 'screen/extensions/useExtensions.ts'))})
    const { AppStoreContext, getDefaultAppState } = await import(${JSON.stringify(join(SRC, 'screen/app-state/AppState.tsx'))})
    const { createStore } = await import(${JSON.stringify(join(SRC, 'platform/primitives/store.ts'))})
    const { default: StdinContext } = await import(${JSON.stringify(join(SRC, 'screen/renderer/elements/StdinContext.ts'))})
    const { Box, EventEmitter, render, flushPendingSyncWork } = await import(${JSON.stringify(join(SRC, 'screen/themedRenderer.ts'))})
    const initial = getDefaultAppState()
    initial.extensions.pending = true
    const store = createStore(initial)
    function Probe() {
      useExtensions({ enabled: true })
      return null
    }
    const emitter = new EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns: 80, rows: 24 })
    const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const inst = await render(
      createElement(AppStoreContext.Provider, { value: store },
        createElement(StdinContext.Provider, { value: stdinValue },
          createElement(Box, null, createElement(Probe)))),
      { stdin, stdout, patchConsole: false, exitOnCtrlC: false },
    )
    for (let i = 0; i < 6; i++) { flushPendingSyncWork(); await new Promise(res => setTimeout(res, 15)) }
    const n = store.getState().notifications
    const all = [...(n.current ? [n.current] : []), ...n.queue]
    out.pending = store.getState().extensions.pending
    out.texts = all.map(item => item.text).filter(Boolean)
    inst.unmount()
    inst.cleanup()
    stream.destroy()
  `)
  const texts = (r.texts as string[]) ?? []
  check('useExtensions: clears pending and notifies user when boot load fails', r.pending === false && texts.some(t => t === 'Extensions could not be loaded (disk offline) — /extensions'), JSON.stringify(r))
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
