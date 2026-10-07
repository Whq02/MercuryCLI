#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
process.on('exit', () => {
  try {
    rmSync(proofHome, { recursive: true, force: true })
  } catch {
  }
})

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sorted = (values: Iterable<number>): string => JSON.stringify([...values].sort((a, b) => a - b))

console.log('============================================================')
console.log(' A Windows shell tree ends whole — proof')
console.log('============================================================')

const group = await import(join(ROOT, 'src/utils/processGroup.ts'))

type Row = { pid: number; ppid: number; pgid: number; winpid: number }
const winpids = (rows: Row[]): string => sorted(rows.map(row => row.winpid))

section('§1 the MSYS table reader and the tree walk (pure)')
{
  const reader = typeof group.parseMsysProcessTable === 'function' && typeof group.msysTreeRows === 'function'
  check('processGroup owns the MSYS table reader and the tree walk', reader)
  if (reader) {
    const text = [
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
      '    22129       1   22129       6276  ?         197609 19:31:07 /usr/bin/bash',
      '    22131   22129   22129       1508  ?         197609 19:31:08 /usr/bin/bash',
      '    22141   22131   22129       8576  ?         197609 19:31:08 /usr/bin/sleep',
      '    22142   22131   22129       2540  ?         197609 19:31:08 /usr/bin/sleep',
      '    22150       1   22129       4416  ?         197609 19:31:09 /usr/bin/sleep',
      '    30001       1   30001       4000  ?         197609 19:31:09 /usr/bin/bash',
      '    30002   30001   30001       4004  ?         197609 19:31:09 /usr/bin/sleep',
      'I   30010   30001   30001       4010  ?         197609 19:31:09 /usr/bin/cat',
      '  4201664       0       0       7360  ?              0   Oct  4 C:\\Users\\x\\node.exe',
    ].join('\r\n')
    const rows = group.parseMsysProcessTable(text) as Row[]
    check('the header is skipped and every row is read, a status letter and a two-word date included', rows.length === 9, `${rows.length} rows`)
    check('a row carries its four numbers', JSON.stringify(rows[2]) === JSON.stringify({ pid: 22141, ppid: 22131, pgid: 22129, winpid: 8576 }), JSON.stringify(rows[2]))
    check('empty or unreadable output reads as no rows', group.parseMsysProcessTable('').length === 0 && group.parseMsysProcessTable('ps: cannot open the table\r\n').length === 0)

    const fresh = () => ({ pids: new Set<number>(), groups: new Set<number>() })
    const whole = sorted([6276, 1508, 8576, 2540, 4416])
    const memory = fresh()
    const first = group.msysTreeRows(rows, memory, [6276]) as Row[]
    check('the shell, its descendants and a member of its group that init adopted are the tree', winpids(first) === whole, winpids(first))
    check('another session sharing nothing with it is left alone', !first.some(row => [4000, 4004, 4010, 7360].includes(row.winpid)))
    const stubbed = group.msysTreeRows(rows, fresh(), [5488, 5476, 6276]) as Row[]
    check('a launcher and a console host that the table does not know add nothing; the shell it started leads the same tree', winpids(stubbed) === whole)
    const afterKill = rows.filter(row => row.pid !== 22129)
    const orphans = group.msysTreeRows(afterKill, memory) as Row[]
    check('with the shell dead and gone from the table its children are still the tree, found through what was learned', winpids(orphans) === sorted([1508, 8576, 2540, 4416]), winpids(orphans))
    const unknown = fresh()
    check('roots the table does not hold give an empty walk and remember nothing', group.msysTreeRows(rows, unknown, [123456]).length === 0 && unknown.pids.size === 0)

    const withSelf = [...rows, { pid: 22160, ppid: 22131, pgid: 22129, winpid: process.pid }, { pid: 22161, ppid: 22160, pgid: 22161, winpid: 9999 }]
    const selfSeen = (group.msysTreeRows(withSelf, fresh(), [6276]) as Row[]).map(row => row.winpid)
    check('the running process is never in the tree, and nothing is claimed through it', !selfSeen.includes(process.pid) && !selfSeen.includes(9999), JSON.stringify(selfSeen))
    const init = fresh()
    const viaInit = group.msysTreeRows([...rows, { pid: 1, ppid: 0, pgid: 1, winpid: 5000 }], init, [5000]) as Row[]
    check("the table's init is never a root: its adopted children are not swept up through it", viaInit.length === 0 && init.pids.size === 0)
    const cycle = [
      { pid: 50, ppid: 51, pgid: 50, winpid: 600 },
      { pid: 51, ppid: 50, pgid: 50, winpid: 601 },
    ]
    check('a table that loops back on itself ends the walk', winpids(group.msysTreeRows(cycle, fresh(), [600]) as Row[]) === sorted([600, 601]))
  }
  check('the taskkill command for one tree is unchanged: /PID <pid> /T /F', JSON.stringify(group.win32TaskkillCommand(4242).args) === JSON.stringify(['/PID', '4242', '/T', '/F']))
  const sweepCommand = typeof group.win32TaskkillSweepCommand === 'function' ? group.win32TaskkillSweepCommand([11, 22]) : null
  check('the sweep names every pid, then /T /F, through the same System32 taskkill.exe', sweepCommand !== null && JSON.stringify(sweepCommand.args) === JSON.stringify(['/PID', '11', '/PID', '22', '/T', '/F']) && sweepCommand.file === group.win32TaskkillCommand(1).file)
}

type Tagged = { pid: number; ppid: number; name: string }
const QUERY = String.raw`
$tags = $env:PROVE_TAGS -split ','
Get-CimInstance Win32_Process -Filter "Name='bash.exe' OR Name='sleep.exe' OR Name='ping.exe'" | ForEach-Object {
  $line = [string]$_.CommandLine
  foreach ($tag in $tags) {
    if ($line -match ('(^|[^0-9])' + $tag + '([^0-9]|$)')) { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name; break }
  }
}
'END'
`
const queryOnce = (tags: number[]): Promise<Tagged[] | null> =>
  new Promise(resolve => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { encoding: 'utf8', windowsHide: true, timeout: 90_000, env: { ...process.env, PROVE_TAGS: tags.join(',') } },
      (error, stdout) => {
        const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim())
        if (error || !lines.includes('END')) return resolve(null)
        const found: Tagged[] = []
        for (const line of lines) {
          const parts = line.split('|')
          if (parts.length === 3 && /^\d+$/.test(parts[0]!)) found.push({ pid: Number(parts[0]), ppid: Number(parts[1]), name: parts[2]!.toLowerCase() })
        }
        resolve(found)
      },
    )
  })
const tagged = async (tags: number[]): Promise<Tagged[]> => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = await queryOnce(tags)
    if (found !== null) return found
    await sleep(500)
  }
  throw new Error('the process table could not be read')
}
const describe = (procs: Tagged[]): string => procs.map(p => `${p.name}#${p.pid}`).join(' ')
const leavesOf = (procs: Tagged[]): number => procs.filter(p => p.name !== 'bash.exe').length
const everyTag: number[] = []
let nextTag = 40_000 + Math.floor(Math.random() * 15_000) * 2
const freshTags = (count: number): number[] => {
  const tags = Array.from({ length: count }, (_, i) => nextTag + i)
  nextTag += count + 1
  everyTag.push(...tags)
  return tags
}

type Location = { path: string } | { absent: true }
const gitBash: string | null = await (async () => {
  if (process.platform !== 'win32') return null
  const { locateGitBash } = (await import(join(ROOT, 'src/utils/windowsPaths.ts'))) as { locateGitBash: () => Location }
  const location = locateGitBash()
  return 'path' in location ? location.path : null
})()

if (process.platform !== 'win32') {
  section('§2 the live legs')
  console.log('  [SKIP] the live legs read the Windows process table; POSIX ends the tree through its process group (prove-stop-ends-the-tree)')
} else if (gitBash === null) {
  section('§2 the live legs')
  console.log('  [SKIP] no Git Bash on this host: the Bash tool has no shell tree to end here')
} else {
  process.env.SHELL = gitBash
  const { exec, setCwd } = await import(join(ROOT, 'src/utils/Shell.ts'))
  const { setOriginalCwd } = await import(join(ROOT, 'src/bootstrap/state.ts'))
  const { generateTaskId } = await import(join(ROOT, 'src/Task.ts'))
  const { TaskOutput } = await import(join(ROOT, 'src/utils/task/TaskOutput.ts'))
  const { wrapSpawn } = await import(join(ROOT, 'src/utils/ShellCommand.ts'))
  const { killTask } = await import(join(ROOT, 'src/tasks/LocalShellTask/killShellTasks.ts'))
  const { spawnShellTask } = await import(join(ROOT, 'src/tasks/LocalShellTask/LocalShellTask.tsx'))
  const { runCleanupFunctions } = await import(join(ROOT, 'src/utils/cleanupRegistry.ts'))

  const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'win32-tree-ends-')))
  mkdirSync(join(PROJECT, 'sub'), { recursive: true })
  process.chdir(PROJECT)
  setCwd(PROJECT)
  setOriginalCwd(PROJECT)
  process.on('exit', () => {
    try {
      process.chdir(ROOT)
      rmSync(PROJECT, { recursive: true, force: true })
    } catch {
    }
  })

  const everySeen: Tagged[] = []
  const reapAll = (procs: Tagged[]): void => {
    for (const p of procs) {
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
      }
    }
  }
  const watchdog = setTimeout(() => {
    console.log('  [FAIL] the proof ran past its own budget')
    reapAll(everySeen)
    process.exit(1)
  }, 420_000)
  watchdog.unref()

  const psExe = [join(gitBash, '..', 'ps.exe'), join(gitBash, '..', '..', 'usr', 'bin', 'ps.exe')].find(existsSync) ?? null
  const realBash = /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(gitBash) ? gitBash : join(gitBash, '..', '..', 'usr', 'bin', 'bash.exe')
  note(`the shell the product starts: ${gitBash}`)

  const sleepersListed = (tags: number[]): Promise<number> =>
    new Promise(resolve => {
      if (psExe === null) return resolve(0)
      execFile(psExe, ['-e', '-f'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) => {
        const wanted = new RegExp(`(^|\\s)sleep (${tags.join('|')})(\\s|$)`)
        resolve(String(stdout ?? '').split(/\r?\n/).filter(line => wanted.test(line)).length)
      })
    })
  const treeUp = async (tags: number[], sleeps: number, pings = 0): Promise<Tagged[]> => {
    const deadline = Date.now() + 60_000
    while (psExe !== null && Date.now() < deadline && (await sleepersListed(tags)) < sleeps) await sleep(100)
    let procs: Tagged[] = []
    while (Date.now() < deadline) {
      procs = (await tagged(tags)).filter(p => alive(p.pid))
      if (procs.filter(p => p.name === 'sleep.exe').length >= sleeps && procs.filter(p => p.name === 'ping.exe').length >= pings) break
      await sleep(200)
    }
    everySeen.push(...procs)
    return procs
  }
  const survivorsOf = async (procs: Tagged[], budgetMs = 8_000): Promise<Tagged[]> => {
    const deadline = Date.now() + budgetMs
    let left = procs.filter(p => alive(p.pid))
    while (left.length > 0 && Date.now() < deadline) {
      await sleep(150)
      left = procs.filter(p => alive(p.pid))
    }
    return left
  }
  const run = (command: string, options: Record<string, unknown> = {}) =>
    exec(command, new AbortController().signal, 'bash', { timeout: 900_000, shouldAutoBackground: false, ...options })
  const taskHarness = () => {
    let state: { tasks: Record<string, any> } = { tasks: {} }
    return {
      get: () => state,
      context: {
        abortController: new AbortController(),
        getAppState: () => state,
        setAppState: (f: (prev: any) => any): void => {
          state = f(state)
        },
      },
    }
  }

  section('§2 three jobs started now and settled at the end: a backgrounded one, a timed-out one and a bystander')
  const [deadlineA, deadlineB] = freshTags(2)
  const deadlineJob = await run(`bash -c 'sleep ${deadlineA} & sleep ${deadlineB}'`, { timeout: 3_000, shouldAutoBackground: true })
  let backgrounded: boolean | null = null
  deadlineJob.onTimeout?.((backgroundFn: (taskId: string) => boolean) => {
    backgrounded = backgroundFn(generateTaskId('local_bash'))
  })
  const [timedA, timedB] = freshTags(2)
  const timedJob = await run(`bash -c 'sleep ${timedA} & sleep ${timedB}'`, { timeout: 25_000 })
  const bystanderTags = freshTags(2)
  const bystander = await run(`bash -c 'sleep ${bystanderTags[0]} & sleep ${bystanderTags[1]}'`)
  const deadlineUp = await treeUp([deadlineA!, deadlineB!], 2)
  const timedUp = await treeUp([timedA!, timedB!], 2)
  const bystanders = await treeUp(bystanderTags, 2)
  check('§2 the bystander tree is up', leavesOf(bystanders) === 2, describe(bystanders))
  check("§2 the timed-out job's tree is up", leavesOf(timedUp) === 2, describe(timedUp))
  check("§2 the backgrounded job's tree is up", leavesOf(deadlineUp) === 2, describe(deadlineUp))
  for (let i = 0; i < 100 && backgrounded === null; i++) await sleep(100)
  check('§2 the 3s timeout moved the job to the background and its tree keeps running', backgrounded === true && deadlineJob.status === 'backgrounded' && deadlineUp.filter(p => p.name === 'sleep.exe' && alive(p.pid)).length === 2, `backgrounded=${backgrounded} status=${deadlineJob.status}`)

  section('§3 a stop (TaskStop, Esc, the deadline and the size watchdog all end it this way): the whole tree dies')
  {
    const [a, b, c] = freshTags(3)
    const handle = await run(`bash -c 'bash -c "ping -n ${c} 127.0.0.1 > /dev/null" & bash -c "sleep ${a}" & sleep ${b}'`)
    const up = await treeUp([a!, b!, c!], 2, 1)
    check('§3 the tree is up: two sleeps, a native ping and the shells around them', leavesOf(up) === 3 && up.filter(p => p.name === 'bash.exe').length >= 4, describe(up))
    note(`their windows parents are already gone: ${describe(up.filter(p => !alive(p.ppid))) || 'none'}`)
    handle.kill()
    const receipt = await handle.treeKillReceipt
    const result = await handle.result
    const left = await survivorsOf(up)
    check('§3 every process of the tree is gone', left.length === 0, `still alive: ${describe(left)}`)
    check('§3 the receipt names no survivor', receipt.survivors.length === 0, JSON.stringify(receipt))
    check('§3 the receipt counts the leaves and the shells it ended', receipt.ended >= leavesOf(up) + 2, `ended ${receipt.ended}, saw ${describe(up)}`)
    check('§3 a stop still reads as an interrupt', result.interrupted === true && handle.status === 'killed', `interrupted=${result.interrupted} status=${handle.status}`)
    reapAll(up)
  }

  section('§4 TaskStop: the settlement counts the tree and names no survivor')
  {
    const [a, b] = freshTags(2)
    const handle = await run(`bash -c 'sleep ${a} & sleep ${b}'`)
    const harness = taskHarness()
    const spawned = await spawnShellTask({ command: 'a shell tree', description: 'a shell tree', shellCommand: handle }, harness.context as any)
    const up = await treeUp([a!, b!], 2)
    check('§4 the task is running and its tree is up', harness.get().tasks[spawned.taskId]?.status === 'running' && leavesOf(up) === 2, describe(up))
    const settlement = (await killTask(spawned.taskId, harness.context.setAppState)) as any
    const left = await survivorsOf(up)
    check('§4 the stop settled as an interrupt', settlement.settled === true && settlement.interrupted === true, JSON.stringify(settlement))
    check('§4 the settlement counts the sleeps and the shells it ended', typeof settlement.processesEnded === 'number' && settlement.processesEnded >= leavesOf(up) + 2, `${JSON.stringify(settlement)} saw ${describe(up)}`)
    check('§4 the settlement names no survivor', settlement.processSurvivors === undefined, JSON.stringify(settlement))
    check('§4 every process of the tree is gone', left.length === 0, `still alive: ${describe(left)}`)
    reapAll(up)
  }

  section('§5 the process exit: a backgrounded job and its whole tree die with the session')
  {
    const [a, b, c] = freshTags(3)
    const handle = await run(`bash -c 'ping -n ${c} 127.0.0.1 > /dev/null & sleep ${a} & sleep ${b}'`)
    const harness = taskHarness()
    const spawned = await spawnShellTask({ command: 'a shell tree with a native child', description: 'a shell tree with a native child', shellCommand: handle }, harness.context as any)
    const up = await treeUp([a!, b!, c!], 2, 1)
    check('§5 the task is running and its tree is up: two sleeps and a native ping', harness.get().tasks[spawned.taskId]?.status === 'running' && leavesOf(up) === 3, describe(up))
    await runCleanupFunctions()
    const left = await survivorsOf(up)
    check('§5 the registered cleanup ended the task', harness.get().tasks[spawned.taskId]?.status === 'killed', `status=${harness.get().tasks[spawned.taskId]?.status}`)
    check('§5 every process of the tree is gone, the native child too', left.length === 0, `still alive: ${describe(left)}`)
    reapAll(up)
  }

  section('§6 the shell binary itself as the root, with no launcher in front of it')
  if (!existsSync(realBash)) {
    console.log(`  [SKIP] no ${realBash} on this host`)
  } else {
    const [a, b] = freshTags(2)
    const child = spawn(realBash, ['-c', `eval "bash -c 'sleep ${a} & sleep ${b}'"`], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: false })
    child.stdin?.end()
    const handle = wrapSpawn(child, new AbortController().signal, 900_000, new TaskOutput(generateTaskId('local_bash'), null))
    const up = await treeUp([a!, b!], 2)
    check('§6 the tree is up', leavesOf(up) === 2, describe(up))
    handle.kill()
    const receipt = await handle.treeKillReceipt
    const left = await survivorsOf(up)
    check('§6 every process of the tree is gone', left.length === 0, `still alive: ${describe(left)}`)
    check('§6 the receipt names no survivor', receipt !== undefined && receipt.survivors.length === 0, JSON.stringify(receipt))
    handle.cleanup()
    reapAll(up)
  }

  section('§7 a tree with no shell in it ends exactly as before')
  {
    const hold = 600_000 + freshTags(1)[0]!
    const script = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${hold})'], { stdio: 'ignore' }); console.log('GRAND ' + g.pid); setTimeout(() => {}, ${hold})`
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let grand = -1
    let heard = ''
    child.stdout!.on('data', chunk => {
      heard += String(chunk)
      const match = /GRAND (\d+)/.exec(heard)
      if (match) grand = Number(match[1])
    })
    const deadline = Date.now() + 20_000
    while (grand < 0 && Date.now() < deadline) await sleep(100)
    check('§7 the tree is up', grand > 1 && alive(child.pid!) && alive(grand), `grandchild ${grand}`)
    const receipt = await group.endProcessTree(child, 'SIGKILL')
    check('§7 both ended and nothing survived', receipt.ended >= 2 && receipt.survivors.length === 0, JSON.stringify(receipt))
    check('§7 the root and its child are gone', !alive(child.pid!) && !alive(grand))
    if (alive(grand)) process.kill(grand, 'SIGKILL')
  }

  section('§8 the timeout without auto-background reaches its end: the whole tree dies and the words stay')
  {
    const result = await timedJob.result
    const receipt = await timedJob.treeKillReceipt
    const left = await survivorsOf(timedUp)
    check('§8 the timeout says so in the same words', result.stderr.includes('Command timed out after 25s'), JSON.stringify(result.stderr.slice(0, 120)))
    check('§8 it is a timeout, not an interrupt', result.interrupted === false, `interrupted=${result.interrupted}`)
    check('§8 every process of the tree is gone', left.length === 0, `still alive: ${describe(left)}`)
    check('§8 the receipt names no survivor', receipt !== undefined && receipt.survivors.length === 0, JSON.stringify(receipt))
    reapAll(timedUp)
  }

  section('§9 the backgrounded job reaches its 10x deadline: the whole tree dies and the words stay')
  {
    const result = await deadlineJob.result
    const left = await survivorsOf(deadlineUp)
    check('§9 the deadline says so in the same words', result.stderr.includes('absolute deadline elapsed (10x the original 3s timeout'), JSON.stringify(result.stderr.slice(0, 160)))
    check('§9 it is a policy stop, not an interrupt', result.interrupted === false, `interrupted=${result.interrupted}`)
    check('§9 every process of the tree is gone', left.length === 0, `still alive: ${describe(left)}`)
    reapAll(deadlineUp)
  }

  section('§10 the bystander')
  {
    const sleepers = bystanders.filter(p => p.name === 'sleep.exe')
    const stillUp = sleepers.filter(p => alive(p.pid))
    check('§10 a tree nobody asked to end is still running after all the others ended', stillUp.length === sleepers.length, `alive ${describe(stillUp)} of ${describe(sleepers)}`)
    bystander.kill()
    await bystander.treeKillReceipt
    const gone = await survivorsOf(bystanders)
    check('§10 the bystander ends when it is asked to', gone.length === 0, describe(gone))
    reapAll(bystanders)
  }

  section('§11 the whole box')
  {
    const stragglers = await tagged(everyTag)
    check('§11 no process carrying any number of this run is left running anywhere', stragglers.length === 0, describe(stragglers))
    reapAll(stragglers)
  }
}

if (failures > 0) {
  console.error(`\nprove-win32-shell-tree-ends: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-shell-tree-ends: all green')
process.exit(0)
