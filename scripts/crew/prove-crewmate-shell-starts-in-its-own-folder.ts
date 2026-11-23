#!/usr/bin/env bun
// gate-watch: src/platform/shell/shellExec.ts src/platform/files/cwd.ts src/tools/crewmate/CrewmateTool.tsx src/tools/crewmate/resumeCrewmate.ts
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync } from 'node:fs'
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

const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
const cwdModule = await import('../../src/platform/files/cwd.ts')
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
check('the parent shell starts in the session folder', (await where()) === SESSION, `${await where()} — setCwd in src/platform/shell/shellExec.ts must set the folder the parent's shell starts in`)
await shell(`cd ${JSON.stringify(PARENT_DIR)}`)
check("the parent's own cd persists for the parent", (await where()) === PARENT_DIR, `${await where()} — exec in src/platform/shell/shellExec.ts must keep the parent's own cd for the parent's next call`)
const A = new Crewmate('crewmate-a', fn => runWithCwdOverride(WORKTREE_A, fn))
const B = new Crewmate('crewmate-b', fn => runWithCwdOverride(WORKTREE_B, fn))
const aFirst = await A.where()
check("crewmate A's first call starts in A's worktree, not in the parent's last directory", aFirst === WORKTREE_A, `A started in ${aFirst} — a call made under runWithCwdOverride (src/platform/files/cwd.ts) must start in that override folder, read in exec in src/platform/shell/shellExec.ts`)
const bFirst = await B.where()
check("crewmate B's first call starts in B's worktree", bFirst === WORKTREE_B, `B started in ${bFirst} — a call made under runWithCwdOverride (src/platform/files/cwd.ts) must start in that override folder, read in exec in src/platform/shell/shellExec.ts`)

section('§2 a crewmate moves its shell; its siblings and the parent keep theirs, and its own move persists for it alone')
await A.run(`cd ${JSON.stringify(A_DIR)}`)
const aAfter = await A.where()
check("crewmate A's next call starts where A went (its own cd persists)", aAfter === A_DIR, `A is in ${aAfter} — a crewmate's own cd must persist for that crewmate's next call; see exec in src/platform/shell/shellExec.ts and src/platform/files/cwd.ts`)
const bAfter = await B.where()
check("crewmate B's next call still starts in B's worktree (never A's last directory)", bAfter === WORKTREE_B, `B is in ${bAfter} — one crewmate's cd must not become another's starting folder; see exec in src/platform/shell/shellExec.ts and src/platform/files/cwd.ts`)
const parentAfter = await where()
check("the parent's next call still starts where the parent went (never a crewmate's last directory)", parentAfter === PARENT_DIR, `the parent is in ${parentAfter} — a crewmate's cd must not move the parent's shell; see exec in src/platform/shell/shellExec.ts and src/platform/files/cwd.ts`)

section('§3 the same context holds across concurrent calls (two crewmates in flight at once)')
{
  const [a, b] = await Promise.all([A.run('sleep 0.3; pwd -P'), B.where()])
  check('A and B report their own folders when their commands overlap', a === A_DIR && b === WORKTREE_B, `A ${a} · B ${b} — the per-crewmate folder must be held per async context (src/platform/files/cwd.ts), so overlapping calls do not share it`)
}

section("§4 a crewmate without a folder of its own starts in the session's folder, and its moves are its own")
const C = new Crewmate('crewmate-c', fn => runWithOwnShellCwd(fn))
const cFirst = await C.where()
check("a plain crewmate's shell starts in the session folder, not in the parent's last directory", cFirst === SESSION, `C started in ${cFirst} — runWithOwnShellCwd in src/platform/files/cwd.ts must seed the crewmate's folder from the session folder, not the parent's last directory`)
await C.run(`cd ${JSON.stringify(C_DIR)}`)
check("the plain crewmate's cd persists for it", (await C.where()) === C_DIR, `${await C.where()} — a plain crewmate's cd must persist for it; see runWithOwnShellCwd in src/platform/files/cwd.ts and exec in src/platform/shell/shellExec.ts`)
const parentAfterC = await where()
check("the plain crewmate's cd does not move the parent's shell", parentAfterC === PARENT_DIR, `the parent is in ${parentAfterC} — a plain crewmate's cd must not move the parent's shell; see runWithOwnShellCwd in src/platform/files/cwd.ts`)
const D = await A.spawnPlain('crewmate-d')
const nested = await D.where()
check("a crewmate launched by crewmate A (from inside A's live context after A cd'd) starts in A's launch folder, not where A's shell went", nested === WORKTREE_A, `D started in ${nested} — a crewmate launched inside another's context must start in the launcher's launch folder; see runWithOwnShellCwd in src/platform/files/cwd.ts`)
await D.run(`cd ${JSON.stringify(C_DIR)}`)
check("the nested crewmate's cd persists for it and does not move its launcher A", (await D.where()) === C_DIR && (await A.where()) === A_DIR, `D ${await D.where()} · A ${await A.where()} — a nested crewmate's cd must stay its own; see runWithOwnShellCwd in src/platform/files/cwd.ts`)
const P = new Crewmate('crewmate-p', fn => runWithOwnShellCwd(fn))
const OTHER_SESSION = folder('other-session')
setCwd(OTHER_SESSION)
await shell(`cd ${JSON.stringify(PARENT_DIR)}`)
const pFirst = await P.where()
check("a plain crewmate seeded from the session folder at launch keeps that folder even if the parent later changes setCwd", pFirst === SESSION, `P started in ${pFirst} — runWithOwnShellCwd in src/platform/files/cwd.ts must capture the session folder at launch, before a later setCwd (src/platform/shell/shellExec.ts)`)
const VANISHED = folder('vanished-worktree')
const V = new Crewmate('crewmate-v', fn => runWithCwdOverride(VANISHED, fn))
rmdirSync(VANISHED)
await V.where()
const parentAfterVanished = await where()
check("a crewmate recovering from a deleted folder never resets the parent's cwdState or shell directory", parentAfterVanished === PARENT_DIR, `the parent is in ${parentAfterVanished} — recovery from a deleted crewmate folder in exec (src/platform/shell/shellExec.ts) must not reset the parent's cwd state`)
for (const crewmate of [A, B, C, D, P, V]) crewmate.end()


console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? "GREEN: a crewmate's shell starts in its own folder every call" : `RED: ${failures} check(s) show a shell following another's directory`)
process.exit(failures === 0 ? 0 : 1)
