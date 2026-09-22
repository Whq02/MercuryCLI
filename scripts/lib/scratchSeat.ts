import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bootRunner, bound, childEnv, isResult, makeTally, sleep, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'

export { DIST, NODE, SCRATCH_ROOT, bound, childEnv, isResult, makeTally, seedScratchHome, sleep, startScriptedFixture, user }
export type { Script, ScriptedFixture, ScriptedRequest, WireBlock }

export type Turn = { result: Record<string, unknown> | null; stderr: string; exitCode: number | null; frames: unknown[] }

export function requireDist(): void {
  if (!existsSync(DIST)) {
    console.log(`  [FAIL] ${DIST} absent: build first, or pass --dist`)
    process.exit(1)
  }
  console.log(`build under proof: ${DIST}`)
  const manifest = join(DIST, '..', 'manifest.json')
  if (existsSync(manifest)) {
    try {
      const tree = (JSON.parse(readFileSync(manifest, 'utf8')) as { buildTree?: string }).buildTree
      console.log(`manifest buildTree: ${tree ?? 'unknown'}`)
    } catch {
      console.log('manifest unreadable')
    }
  }
}

export function scratchWorld(prefix: string): { runHome: string; cwd: string } {
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`)))
  const runHome = join(root, 'home')
  const cwd = join(root, 'work')
  mkdirSync(runHome, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { runHome, cwd }
}

export async function runTurn(args: {
  runHome: string
  cwd: string
  base: string
  ask: string
  timeoutMs?: number
  extraEnv?: Record<string, string>
  extraArgv?: string[]
}): Promise<Turn> {
  const port = Number(new URL(args.base).port)
  const runner = bootRunner({
    cwd: args.cwd,
    env: { ...childEnv(args.runHome, port), ...(args.extraEnv ?? {}) },
    ...(args.extraArgv ? { extraArgv: args.extraArgv } : {}),
  })
  runner.send(user(args.ask, randomUUID()))
  const result = await runner.waitFor('result', isResult, bound(args.timeoutMs ?? 90_000))
  await runner.stop(bound(5_000))
  return { result: result as Record<string, unknown> | null, stderr: runner.stderr(), exitCode: await runner.exited, frames: runner.frames }
}

export function findTranscripts(runHome: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(join(runHome, 'projects'))
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

export function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

export const textScript = (text: string): Script => () => [{ type: 'text', text }]
