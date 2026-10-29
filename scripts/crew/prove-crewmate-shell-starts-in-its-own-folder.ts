#!/usr/bin/env bun
// gate-watch: src/utils/Shell.ts src/utils/cwd.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/resumeAgent.ts
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from 'node:fs'
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

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(" a crewmate's shell starts in the crewmate's own folder, every call")
console.log(' (the parent and every sibling keep their own last directory; nobody follows another)')
console.log('============================================================')

const { exec, setCwd } = await import('../../src/utils/Shell.ts')
const cwdModule = await import('../../src/utils/cwd.ts')
const { runWithCwdOverride } = cwdModule
const runWithOwnShellCwd: <T>(fn: () => T) => T =
  (cwdModule as { runWithOwnShellCwd?: <T>(fn: () => T) => T }).runWithOwnShellCwd ?? (fn => fn())

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'crewmate-own-folder-')))
const folder = (name: string): string => {
  const path = join(SCRATCH, name)
  mkdirSync(path, { recursive: true })
  return path
}
const SESSION = folder('session')
const WORKTREE_A = folder('worktree-a')
const WORKTREE_B = folder('worktree-b')
const PARENT_DIR = folder('parent-went-here')
const A_DIR = folder('a-went-here')
const C_DIR = folder('c-went-here')
setCwd(SESSION)

async function shell(command: string, owner?: string): Promise<string> {
  const controller = new AbortController()
  const handle = await exec(command, controller.signal, 'bash', { timeout: 20_000, shouldAutoBackground: false, ...(owner === undefined ? {} : { owner }) })
  const result = await handle.result
  return result.stdout.trim()
}
const where = (owner?: string): Promise<string> => shell('pwd -P', owner)

type Job = { command?: string; spawnName?: string; resolve: (out: string) => void; resolveChild?: (child: Crewmate) => void }
class Crewmate {
  private jobs: Job[] = []
  private wake: (() => void) | null = null
  private ended = false
  constructor(readonly name: string, enter: <T>(fn: () => T) => T) {
    void enter(() => this.loop())
  }
  private async loop(): Promise<void> {
    while (!this.ended) {
      const job = this.jobs.shift()
      if (job === undefined) {
        await new Promise<void>(resolve => {
          this.wake = resolve
        })
        continue
      }
      if (job.spawnName !== undefined && job.resolveChild !== undefined) {
        job.resolveChild(new Crewmate(job.spawnName, fn => runWithOwnShellCwd(fn)))
        continue
      }
      job.resolve(await shell(job.command!, this.name))
    }
  }
  run(command: string): Promise<string> {
    return new Promise(resolve => {
      this.jobs.push({ command, resolve })
      this.wake?.()
      this.wake = null
    })
  }
  spawnPlain(name: string): Promise<Crewmate> {
    return new Promise(resolveChild => {
      this.jobs.push({ spawnName: name, resolve: () => {}, resolveChild })
      this.wake?.()
      this.wake = null
    })
  }
  where(): Promise<string> {
    return this.run('pwd -P')
  }
  end(): void {
    this.ended = true
    this.wake?.()
  }
}

section('§1 the parent moved its shell; a crewmate with its own folder starts there, not where the parent went')
check('the parent shell starts in the session folder', (await where()) === SESSION, await where())
await shell(`cd ${JSON.stringify(PARENT_DIR)}`)
check("the parent's own cd persists for the parent", (await where()) === PARENT_DIR, await where())
const A = new Crewmate('crewmate-a', fn => runWithCwdOverride(WORKTREE_A, fn))
const B = new Crewmate('crewmate-b', fn => runWithCwdOverride(WORKTREE_B, fn))
const aFirst = await A.where()
check("crewmate A's first call starts in A's worktree, not in the parent's last directory", aFirst === WORKTREE_A, `A started in ${aFirst}`)
const bFirst = await B.where()
check("crewmate B's first call starts in B's worktree", bFirst === WORKTREE_B, `B started in ${bFirst}`)

section('§2 a crewmate moves its shell; its siblings and the parent keep theirs, and its own move persists for it alone')
await A.run(`cd ${JSON.stringify(A_DIR)}`)
const aAfter = await A.where()
check("crewmate A's next call starts where A went (its own cd persists)", aAfter === A_DIR, `A is in ${aAfter}`)
const bAfter = await B.where()
check("crewmate B's next call still starts in B's worktree (never A's last directory)", bAfter === WORKTREE_B, `B is in ${bAfter}`)
const parentAfter = await where()
check("the parent's next call still starts where the parent went (never a crewmate's last directory)", parentAfter === PARENT_DIR, `the parent is in ${parentAfter}`)

section('§3 the same context holds across concurrent calls (two crewmates in flight at once)')
{
  const [a, b] = await Promise.all([A.run('sleep 0.3; pwd -P'), B.where()])
  check('A and B report their own folders when their commands overlap', a === A_DIR && b === WORKTREE_B, `A ${a} · B ${b}`)
}

section("§4 a crewmate without a folder of its own starts in the session's folder, and its moves are its own")
const C = new Crewmate('crewmate-c', fn => runWithOwnShellCwd(fn))
const cFirst = await C.where()
check("a plain crewmate's shell starts in the session folder, not in the parent's last directory", cFirst === SESSION, `C started in ${cFirst}`)
await C.run(`cd ${JSON.stringify(C_DIR)}`)
check("the plain crewmate's cd persists for it", (await C.where()) === C_DIR, await C.where())
const parentAfterC = await where()
check("the plain crewmate's cd does not move the parent's shell", parentAfterC === PARENT_DIR, `the parent is in ${parentAfterC}`)
const D = await A.spawnPlain('crewmate-d')
const nested = await D.where()
check("a crewmate launched by crewmate A (from inside A's live context after A cd'd) starts in A's launch folder, not where A's shell went", nested === WORKTREE_A, `D started in ${nested}`)
await D.run(`cd ${JSON.stringify(C_DIR)}`)
check("the nested crewmate's cd persists for it and does not move its launcher A", (await D.where()) === C_DIR && (await A.where()) === A_DIR, `D ${await D.where()} · A ${await A.where()}`)
const P = new Crewmate('crewmate-p', fn => runWithOwnShellCwd(fn))
const OTHER_SESSION = folder('other-session')
setCwd(OTHER_SESSION)
await shell(`cd ${JSON.stringify(PARENT_DIR)}`)
const pFirst = await P.where()
check("a plain crewmate seeded from the session folder at launch keeps that folder even if the parent later changes setCwd", pFirst === SESSION, `P started in ${pFirst}`)
const VANISHED = folder('vanished-worktree')
const V = new Crewmate('crewmate-v', fn => runWithCwdOverride(VANISHED, fn))
rmdirSync(VANISHED)
await V.where()
const parentAfterVanished = await where()
check("a crewmate recovering from a deleted folder never resets the parent's cwdState or shell directory", parentAfterVanished === PARENT_DIR, `the parent is in ${parentAfterVanished}`)
for (const crewmate of [A, B, C, D, P, V]) crewmate.end()

section('§5 the launch seams: every crewmate lifecycle runs in a cwd context of its own')
{
  const agentTool = readFileSync(join(ROOT, 'src', 'tools', 'AgentTool', 'AgentTool.tsx'), 'utf8')
  const resume = readFileSync(join(ROOT, 'src', 'tools', 'AgentTool', 'resumeAgent.ts'), 'utf8')
  check('the background lifecycle never runs outside a cwd context', !/cwdOverride\s*\?\s*runWithCwdOverride\(cwdOverride, lifecycle\)\s*:\s*lifecycle\(\)/.test(agentTool) && agentTool.includes('runWithOwnShellCwd(lifecycle)'))
  check('the foreground execute never runs outside a cwd context', !/cwdOverride\s*\?\s*runWithCwdOverride\(cwdOverride, execute\)\s*:\s*execute\(\)/.test(agentTool) && agentTool.includes('runWithOwnShellCwd(execute)'))
  check('a resumed crewmate runs in a cwd context of its own', resume.includes('runWithCwdOverride(directory, runLifecycle)'))
}

console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? "GREEN: a crewmate's shell starts in its own folder every call" : `RED: ${failures} check(s) show a shell following another's directory`)
process.exit(failures === 0 ? 0 : 1)
