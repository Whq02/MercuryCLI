#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_WORKTREE_CLONE
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { createAgentWorktree } = await import('../../src/utils/worktree.ts')
const { operatorPauseGate, parkBeforeTool } = await import('../../src/run-core/pauseGate.ts')
const cloneModule = await import('../../src/utils/worktreeClone.ts')
const readiness = (await import('../../src/utils/worktreeReadiness.ts').catch(() => null)) as null | {
  holdToolsUntil: (agentId: string, ready: Promise<unknown>) => void
  releaseToolHold: (agentId: string) => void
  heldAgentCount: () => number
  worktreeHoldOf: (context: { agentId?: unknown; abortController: { signal: AbortSignal } }) => Promise<void> | undefined
  worktreeReadyOf?: (agentId: string) => Promise<void> | undefined
  hookMayMeetCopy?: (event: string) => boolean
}
type Launch = Awaited<ReturnType<typeof createAgentWorktree>> & { ready?: Promise<void> }
const launch = (slug: string, from?: string): Promise<Launch> => createAgentWorktree(slug, { ...(from !== undefined ? { from } : {}), foldersBehindLaunch: true } as never) as Promise<Launch>

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-first-request-')))
const hold = join(scratch, 'hold')
const pathBefore = process.env.PATH ?? ''
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '<absent>'
  }
}
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (cond: () => boolean, ms = 60_000): Promise<boolean> => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await wait(20)
  return cond()
}
const listing = (root: string): string[] => {
  const rows: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) rows.push(`${rel} -> ${readlinkSync(join(dir, entry.name))}`)
      else if (entry.isDirectory()) {
        rows.push(`${rel}/`)
        walk(join(dir, entry.name), rel)
      } else rows.push(`${rel} ${statSync(join(dir, entry.name)).size}`)
    }
  }
  if (present(root) && lstatSync(root).isDirectory()) walk(root, '')
  return rows
}
const capture = (): { stop: () => string } => {
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  let printed = ''
  process.stdout.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stderr.write
  return {
    stop: () => {
      process.stdout.write = out
      process.stderr.write = err
      return printed
    },
  }
}
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
}
const pausedAt = join(hold, 'paused')
const releaseAt = join(hold, 'release')
const release = (): void => writeFileSync(releaseAt, '')
const rearm = (): void => {
  rmSync(pausedAt, { force: true })
  rmSync(releaseAt, { force: true })
}
const seat = (agentId?: string): { agentId?: string; abortController: AbortController; onSeatWait: (words: string | null) => void; said: Array<string | null> } => {
  const said: Array<string | null> = []
  return { ...(agentId !== undefined ? { agentId } : {}), abortController: new AbortController(), onSeatWait: words => void said.push(words), said }
}
const timed = async (work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now()
  await work()
  return performance.now() - started
}

const makeFixture = (name: string, extra: Record<string, string> = {}): string => {
  const dir = join(scratch, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  for (const [file, body] of Object.entries({ '.gitignore': 'node_modules/\nvendor/*/\n.mercury/\n', 'package.json': `{"name":"${name}"}`, 'vendor/pack-a.lock.json': '{}\n', ...extra })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  for (let pkg = 0; pkg < 6; pkg++) {
    mkdirSync(join(dir, 'node_modules', `pkg-${pkg}`, 'lib'), { recursive: true })
    for (let index = 0; index < 10; index++) writeFileSync(join(dir, 'node_modules', `pkg-${pkg}`, 'lib', `m${index}.js`), `module.exports = ${pkg * 10 + index}\n`)
  }
  mkdirSync(join(dir, 'node_modules', '.bin'))
  symlinkSync('../pkg-0/lib/m0.js', join(dir, 'node_modules', '.bin', 'tool'))
  mkdirSync(join(dir, 'vendor', 'pack-a'))
  writeFileSync(join(dir, 'vendor', 'pack-a', 'marker'), 'pack\n')
  mkdirSync(join(dir, '.mercury'), { recursive: true })
  writeFileSync(join(dir, '.mercury', 'settings.local.json'), '{"permissions":{"deny":["Bash(fixture-denied)"]}}\n')
  return dir
}

mkdirSync(hold)
const fixture = makeFixture('fixture')
const home = join(fixture, '.mercury', 'worktrees')
const whole = listing(join(fixture, 'node_modules'))
enter(fixture)
state.setIsInteractive(true)
config.enableConfigs()

try {
  if (!(volumeClones(scratch) && process.platform !== 'win32')) {
    section('§1 a volume that cannot clone: there is nothing to do behind a launch but make the links')
    skip("the proof's runtime cannot force a clone of one file here: the rows that hold a clone half way have nothing to hold")
    const linked = await launch('agent-ae100001')
    await linked.ready
    check('a launch that does not wait still ends with the links in place', lstatSync(join(linked.worktreePath, 'node_modules')).isSymbolicLink() && linked.prepareFailure === undefined)
    check('…and holds no tool once they are', readiness !== null && readiness.heldAgentCount() === 0)
  } else {
    const realCp = execFileSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim()
    const cloneLine = process.platform === 'darwin' ? `${realCp} -c -R -p "$5/." "$6/" || exit 1` : `${realCp} "$@" || exit 1`
    const head = ['#!/bin/bash', 'if [ "$1" = "--reflink=always" ] && [ "$2" = "--version" ]; then exit 0; fi', '[ "$1 $2 $3 $4" = "-a --reflink=always -T --" ] || exit 64']
    const shims: Record<string, string[]> = {
      pausing: [...head, cloneLine, `case "$5" in */node_modules) : > ${JSON.stringify(pausedAt)}; while [ ! -e ${JSON.stringify(releaseAt)} ]; do sleep 0.05; done ;; esac`, 'exit 0'],
      failing: [...head, 'mkdir -p "$6/half"', 'echo x > "$6/half/file"', 'echo "cp: cannot clone" >&2', 'exit 1'],
      hanging: [...head, 'exec sleep 600'],
    }
    for (const [name, lines] of Object.entries(shims)) {
      mkdirSync(join(scratch, 'shims', name), { recursive: true })
      writeFileSync(join(scratch, 'shims', name, 'cp'), [...lines, ''].join('\n'))
      chmodSync(join(scratch, 'shims', name, 'cp'), 0o755)
    }
    const use = (name: string): void => {
      process.env.PATH = `${join(scratch, 'shims', name)}:${pathBefore}`
    }
    process.env.MERCURY_WORKTREE_CLONE = 'cp'
    use('pausing')

    section('§1 a launch comes back with the copy made, its settings and its lock, while the folders are still being cloned')
    const launching = launch('agent-ae100001')
    const cameBackFirst = await Promise.race([launching.then(() => true), until(() => existsSync(pausedAt)).then(() => wait(1500)).then(() => false)])
    check('the launch comes back while its folder is still being cloned', cameBackFirst)
    if (!cameBackFirst) release()
    const launched = await launching
    const copy = launched.worktreePath
    check('it hands back the promise of the folders', launched.ready !== undefined)
    check('the copy stands with its tracked files and no node_modules yet', present(join(copy, 'package.json')) && (cameBackFirst ? !present(join(copy, 'node_modules')) : false), listing(join(copy, 'node_modules')).length + ' entries there')
    check('its local settings are already there', read(join(copy, '.mercury', 'settings.local.json')) === read(join(fixture, '.mercury', 'settings.local.json')))
    check('its lock is already taken', git(fixture, 'worktree', 'list', '--porcelain').split('\n\n').some(block => block.includes(`worktree ${copy}`) && block.includes('locked')))
    check('it reports no failure', launched.prepareFailure === undefined)
    await until(() => existsSync(pausedAt))
    release()
    await launched.ready
    check('when the promise ends the folders are the copy\'s own, whole', JSON.stringify(listing(join(copy, 'node_modules'))) === JSON.stringify(whole) && read(join(copy, 'vendor', 'pack-a', 'marker')) === 'pack\n' && !lstatSync(join(copy, 'node_modules')).isSymbolicLink())
    check('…and nothing is left beside the copy', readdirSync(home).every(name => !name.startsWith('.cloning-')))
    rearm()

    section('§2 the tools of that crewmate wait for the folders; nobody else\'s do')
    const second = await launch('agent-ae200001')
    const held = seat('agent-ae200001')
    const lead = seat()
    const neighbour = seat('agent-ae299999')
    readiness?.holdToolsUntil('agent-ae200001', second.ready ?? Promise.resolve())
    check('one crewmate is held while its folders are cloned', readiness !== null && readiness.heldAgentCount() === 1, String(readiness?.heldAgentCount()))
    let heldEnded = false
    let wholeWhenItEnded = false
    const heldCall = parkBeforeTool(held as never, 'Read').then(() => {
      heldEnded = true
      wholeWhenItEnded = JSON.stringify(listing(join(second.worktreePath, 'node_modules'))) === JSON.stringify(whole)
    })
    const leadWaited = await timed(() => parkBeforeTool(lead as never, 'Read'))
    const neighbourWaited = await timed(() => parkBeforeTool(neighbour as never, 'Read'))
    check('a tool call of the lead waits on nothing meanwhile: it is through while the held one still waits, and there is no hold for it to await', !heldEnded && readiness !== null && readiness.worktreeHoldOf(lead) === undefined, `${leadWaited.toFixed(1)} ms`)
    check('…nor one of another crewmate', !heldEnded && readiness !== null && readiness.worktreeHoldOf(neighbour) === undefined, `${neighbourWaited.toFixed(1)} ms`)
    await until(() => existsSync(pausedAt))
    await wait(300)
    check('a first tool call of the held crewmate is still waiting, where a read of a file in the folder would find none', !heldEnded && read(join(second.worktreePath, 'node_modules', 'pkg-0', 'lib', 'm0.js')) === '<absent>')
    const heldFor = await timed(async () => {
      await wait(200)
      release()
      await heldCall
    })
    console.log(`  the held call waited ${heldFor.toFixed(0)} ms more beside ${leadWaited.toFixed(1)} ms and ${neighbourWaited.toFixed(1)} ms for the others`)
    check('it goes on when the folders are in place, and answers from the finished folder', heldEnded && wholeWhenItEnded && read(join(second.worktreePath, 'node_modules', 'pkg-0', 'lib', 'm0.js')) === 'module.exports = 0\n')
    check('the hold said nothing on the crewmate\'s row', held.said.length === 0, JSON.stringify(held.said))
    await wait(20)
    check('the hold has left the map', readiness !== null && readiness.heldAgentCount() === 0, String(readiness?.heldAgentCount()))
    rearm()

    section('§3 a crewmate stopped while its clone runs is let go at once, and the copy still ends whole')
    const third = await launch('agent-ae300001')
    const stopped = seat('agent-ae300001')
    readiness?.holdToolsUntil('agent-ae300001', third.ready ?? Promise.resolve())
    let stoppedEnded = false
    const stoppedCall = parkBeforeTool(stopped as never, 'Bash').then(() => {
      stoppedEnded = true
    })
    await until(() => existsSync(pausedAt))
    await wait(100)
    const before = stoppedEnded
    stopped.abortController.abort('stopped')
    await Promise.race([stoppedCall, wait(1000)])
    check('the stop ends its wait while the clone is still under way', !before && stoppedEnded && !present(join(third.worktreePath, 'node_modules')))
    const endWait = readiness?.worktreeReadyOf?.('agent-ae300001')
    let endWaitOver = false
    void endWait?.then(() => {
      endWaitOver = true
    })
    await wait(150)
    check('what runs at the stopped crewmate\'s end can still wait for the folders: the promise is there after the stop and has not settled', endWait !== undefined && !endWaitOver && readiness?.worktreeHoldOf(stopped) === undefined)
    readiness?.releaseToolHold('agent-ae300001')
    check('when the crewmate ends its hold leaves the map, the clone still running', readiness !== null && readiness.heldAgentCount() === 0 && !existsSync(releaseAt))
    release()
    await third.ready
    check('the copy ends with its folders whole all the same', JSON.stringify(listing(join(third.worktreePath, 'node_modules'))) === JSON.stringify(whole))
    await wait(20)
    check('…that promise settles when the folders are in place, and nothing is left to wait for afterwards', endWaitOver && readiness?.worktreeReadyOf?.('agent-ae300001') === undefined)
    rearm()

    section('§4 the operator\'s pause goes through the same gate as before, and speaks as before')
    const pausedSeat = seat('agent-ae400001')
    operatorPauseGate.pause()
    let pausedEnded = false
    const pausedCall = parkBeforeTool(pausedSeat as never, 'Read').then(() => {
      pausedEnded = true
    })
    await wait(150)
    const heldByPause = !pausedEnded
    operatorPauseGate.resume()
    await Promise.race([pausedCall, wait(1000)])
    check('a paused crewmate\'s tool waits for the resume', heldByPause && pausedEnded)
    check('…and its row carries the pause words, then is cleared', JSON.stringify(pausedSeat.said) === JSON.stringify(['paused by the operator · at a tool (Read) — p resumes it', null]), JSON.stringify(pausedSeat.said))

    section('§5 a clone that fails behind the launch makes the link, as one that fails before it, and says nothing')
    use('failing')
    const quiet = capture()
    const failedBehind = await launch('agent-ae500001')
    readiness?.holdToolsUntil('agent-ae500001', failedBehind.ready ?? Promise.resolve())
    await failedBehind.ready
    await wait(20)
    const failedBefore = await createAgentWorktree('agent-ae500002')
    const printed = quiet.stop()
    const shape = (root: string): string => JSON.stringify(listing(root).filter(row => !row.startsWith('.git ')))
    check('the folder is the link to the checkout\'s', lstatSync(join(failedBehind.worktreePath, 'node_modules')).isSymbolicLink() && realpathSync(join(failedBehind.worktreePath, 'node_modules')) === realpathSync(join(fixture, 'node_modules')))
    check('the copy is, entry for entry, the copy a launch that waited ends with', shape(failedBehind.worktreePath) === shape(failedBefore.worktreePath), `${shape(failedBehind.worktreePath)} against ${shape(failedBefore.worktreePath)}`)
    check('no failure is reported, nothing is printed, nothing is left beside the copy', failedBehind.prepareFailure === undefined && printed === '' && readdirSync(home).every(name => !name.startsWith('.cloning-')), JSON.stringify(printed.slice(0, 200)))
    check('…and the hold has ended and left the map', readiness !== null && readiness.heldAgentCount() === 0)

    section('§6 a helper that never answers is ended at its bound')
    use('hanging')
    const boundTarget = join(scratch, 'bound-copy')
    mkdirSync(boundTarget)
    let boundOutcome: readonly string[] = []
    const boundFor = await timed(async () => {
      boundOutcome = await (cloneModule.cloneIntoWorktree as (pairs: unknown, checkout: string, worktree: string, bound?: number) => Promise<string[]>)([{ source: join(fixture, 'node_modules'), target: join(boundTarget, 'node_modules') }], fixture, boundTarget, 1500)
    })
    console.log(`  a cp that sleeps for ten minutes, bounded at 1.5 s, is answered for after ${boundFor.toFixed(0)} ms`)
    check('the clone is given up at the bound, not at the helper\'s pleasure', boundOutcome[0] === 'failed' && boundFor < 20_000, `${boundOutcome[0]} after ${boundFor.toFixed(0)} ms`)
    check('…nothing is left at the name or beside the copy', !present(join(boundTarget, 'node_modules')) && readdirSync(scratch).every(name => !name.startsWith('.cloning-')))
    const cloneSource = readFileSync(join(ROOT, 'src/utils/worktreeClone.ts'), 'utf8')
    check('the macOS helper and cp are both started with that bound, two minutes unless a caller says otherwise', cloneSource.includes("execFileNoThrowWithCwd(OSASCRIPT, ['-l', 'JavaScript', '-e', CLONEFILE_SCRIPT], {") && cloneSource.split('timeout: answerBoundMs').length === 3 && cloneSource.includes('const CLONE_ANSWER_BOUND_MS = 120_000') && cloneSource.includes('answerBoundMs: number = CLONE_ANSWER_BOUND_MS'))

    section('§7 a launch still waits where the user set up steps of their own, and for every other caller')
    use('pausing')
    release()
    const plain = await createAgentWorktree('agent-ae700001')
    check('a caller that does not ask gets the folders before the call returns, and no promise', (plain as Launch).ready === undefined && JSON.stringify(listing(join(plain.worktreePath, 'node_modules'))) === JSON.stringify(whole))
    const again = await launch('agent-ae700001')
    check('a copy that already exists is handed back as it is, with no promise', again.ready === undefined && again.worktreePath === plain.worktreePath)
    const including = makeFixture('including', { '.worktreeinclude': 'private.txt\n' })
    writeFileSync(join(including, 'private.txt'), 'kept out of git\n')
    writeFileSync(join(including, '.gitignore'), 'node_modules/\nvendor/*/\n.mercury/\nprivate.txt\n')
    git(including, 'commit', '-q', '-am', 'ignore the private file')
    const withInclude = await launch('agent-ae700002', including)
    check('a project with a .worktreeinclude file is waited for: folders and included file in place, no promise', withInclude.ready === undefined && present(join(withInclude.worktreePath, 'node_modules', 'pkg-0')) && read(join(withInclude.worktreePath, 'private.txt')) === 'kept out of git\n')
    writeFileSync(join(fixture, '.mercury', 'settings.json'), JSON.stringify({ workspace: { worktree: { prepare: 'echo "codegen missing" >&2; exit 3' } } }))
    resetSettingsCache()
    const withPrepare = await launch('agent-ae700003')
    check('workspace.worktree.prepare is waited for and its failure reported as before, no promise', withPrepare.ready === undefined && withPrepare.prepareFailure === 'workspace.worktree.prepare failed with exit 3: codegen missing' && present(join(withPrepare.worktreePath, 'node_modules', 'pkg-0')), JSON.stringify(withPrepare.prepareFailure))
    rmSync(join(fixture, '.mercury', 'settings.json'))
    resetSettingsCache()

    section('§8 a hook that could run in the crewmate\'s directory before a tool call makes the crewmate wait for its folders first')
    const { HOOK_EVENTS } = await import('../../src/utils/hooks/contract.ts')
    const behindTheGate = ['tool.before', 'tool.after', 'permission.ask', 'permission.decided', 'session.start', 'session.end', 'session.state', 'file.changed']
    const mayMeet = (event: string): boolean => readiness?.hookMayMeetCopy?.(event) === true
    check('the hooks of a tool call and of a permission ask run inside a tool call, behind the gate, and the session\'s own never run in a crewmate\'s directory: none of these makes a crewmate wait', readiness?.hookMayMeetCopy !== undefined && behindTheGate.every(event => (HOOK_EVENTS as readonly string[]).includes(event) && !mayMeet(event)), behindTheGate.filter(mayMeet).join(', '))
    check('every other moment the contract names does: the start, the answer, the turn\'s end, the crewmate\'s end, a fold before and after, a turn\'s start', ['crewmate.start', 'turn.answer', 'turn.end', 'crewmate.end', 'compaction.before', 'compaction.after', 'turn.start'].every(event => (HOOK_EVENTS as readonly string[]).includes(event) && mayMeet(event)) && (HOOK_EVENTS as readonly string[]).filter(event => !behindTheGate.includes(event)).every(mayMeet), (HOOK_EVENTS as readonly string[]).filter(event => !behindTheGate.includes(event) && !mayMeet(event)).join(', '))
    check('…and so does a moment the contract does not name yet', mayMeet('some.later.moment'))
    const runAgentSource = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
    check('runAgent asks it of every moment of the contract before the start hook fires, and a crewmate whose own definition carries hooks waits too', runAgentSource.includes("if (agentDefinition.hooks !== undefined || HOOK_EVENTS.some(event => hookMayMeetCopy(event) && hasHooksFor(event, hookScope, toolUseContext.getAppState()))) await worktreeHoldOf({ agentId, abortController })\n      const started = await fireHooks(\n        'crewmate.start',"))
    check('the hooks of a crewmate\'s end wait for the folders themselves, whatever ended it', runAgentSource.includes("if (hasHooksFor('turn.end', hookScope, toolUseContext.getAppState()) || hasHooksFor('crewmate.end', hookScope, toolUseContext.getAppState())) await worktreeReadyOf(agentId)\n      await fireHooks(\n        'turn.end',"))

    section('§9 where the wait sits')
    const orchestration = readFileSync(join(ROOT, 'src/services/tools/toolOrchestration.ts'), 'utf8')
    const early = readFileSync(join(ROOT, 'src/services/tools/earlyStarts.ts'), 'utf8')
    const gate = readFileSync(join(ROOT, 'src/run-core/pauseGate.ts'), 'utf8')
    const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
    check('every tool call of both roads passes parkBeforeTool before it runs', orchestration.includes('await parkBeforeTool(context, block.name)') && orchestration.split('if (taken === undefined) await parkBeforeBlock(block, ').length === 3 && early.indexOf('await parkBeforeTool(context, block.name)') > 0 && early.indexOf('await parkBeforeTool(context, block.name)') < early.indexOf('for await (const update of runToolUse(block, parent, this.gate, context'))
    check('parkBeforeTool waits on the crewmate\'s folders first, and only when there is a hold', gate.includes('  const held = worktreeHoldOf(context)\n  if (held !== undefined) await held\n  let spoke = false'))
    check('the Crewmate tool launches without waiting, holds that crewmate\'s tools, and ends the crewmate on finished folders', agentTool.includes('foldersBehindLaunch: true,') && agentTool.includes('if (worktreeInfo.ready !== undefined) holdToolsUntil(earlyAgentId, worktreeInfo.ready)') && agentTool.indexOf('releaseToolHold(earlyAgentId)\n      await worktreeInfo.ready') > 0 && agentTool.indexOf('releaseToolHold(earlyAgentId)\n      await worktreeInfo.ready') < agentTool.indexOf('await unlockAgentWorktree(worktreeInfo.worktreePath, worktreeInfo.gitRoot)'))
  }
} finally {
  release()
  operatorPauseGate.resume()
  process.env.PATH = pathBefore
  delete process.env.MERCURY_WORKTREE_CLONE
  enter(ROOT)
  await wait(200)
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
