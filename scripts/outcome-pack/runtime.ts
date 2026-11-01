import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runScriptedTurn, startScriptedFixture, type Script, type WireBlock } from '../lib/scriptedTurn.ts'

export type Requirement = { id: string; ok: boolean; witness: string }
export type RunFacts = {
  runId: string
  sessionId: string
  exitCode: number | null
  settled: boolean
  ordinaryCheck: boolean
  events: Array<{ kind: string; at: string; monotonicMs: number; detail: unknown }>
  effects: Record<string, unknown>
}
export type Context = { cwd: string; runHome: string; scratch: string; dist: string; files: string[]; protected: Record<string, string>; evaluatorVersion: string; facts: RunFacts }
export type Acceptance = { verdict: 'accept' | 'refuse'; witness: Requirement[]; treeDigest: string; checkedPaths: string[]; checkStart: string; checkEnd: string; runId: string; evaluatorVersion: string }
export type Change = { path: string; before: string; after: string }

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
export function snapshot(cwd: string): Record<string, string> {
  const files = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd, encoding: 'utf8' }).split('\0').filter(p => p && p !== '.mercury' && !p.startsWith('.mercury/'))
  return Object.fromEntries([...new Set(files)].sort().map(p => [p, existsSync(join(cwd, p)) ? sha256(readFileSync(join(cwd, p))) : 'absent']))
}
export const digest = (cwd: string): string => sha256(JSON.stringify(snapshot(cwd)))
export function event(facts: RunFacts, kind: string, detail: unknown = null): void {
  facts.events.push({ kind, at: new Date().toISOString(), monotonicMs: performance.now(), detail })
}
export function materialize(cwd: string, scratch: string, patch: string, allowed: string[]): Change[] {
  const target = join(scratch, 'patch-tree')
  git(scratch, ['clone', '-q', '--no-hardlinks', cwd, target])
  try {
    git(target, ['apply', '--check', patch])
    git(target, ['apply', patch])
    const paths = git(target, ['diff', '--name-only']).split('\n').filter(Boolean)
    if (paths.length === 0 || paths.some(p => !allowed.includes(p))) throw new Error('patch changed paths outside the specification')
    return paths.map(p => ({ path: p, before: readFileSync(join(cwd, p), 'utf8'), after: readFileSync(join(target, p), 'utf8') }))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}
export function patchScript(ctx: Context, changes: Change[]): Script {
  const calls: WireBlock[] = changes.flatMap(change => [
    { type: 'tool_use' as const, name: 'Read', input: { file_path: join(ctx.cwd, change.path) } },
    { type: 'tool_use' as const, name: 'Edit', input: { file_path: join(ctx.cwd, change.path), old_string: change.before, new_string: change.after } },
  ])
  calls.push({ type: 'tool_use', name: 'Bash', input: { command: 'npm test', cwd: ctx.cwd, timeout: 30000, description: 'Run the task ordinary check' } })
  return req => {
    if (req.step > 0) {
      const previous = calls[req.step - 1]
      const ok = req.results.length > 0 && req.results.every(result => !result.isError)
      event(ctx.facts, 'tool-settled', { tool: previous?.type === 'tool_use' ? previous.name : '', ok })
      if (req.step === calls.length) ctx.facts.ordinaryCheck = ok
    }
    if (req.step === calls.length - 1) ctx.facts.effects.firstCandidateHash = digest(ctx.cwd)
    return calls[req.step] ? [calls[req.step]!] : [{ type: 'text', text: 'Done.' }]
  }
}
export async function drive(ctx: Context, script: Script): Promise<void> {
  const fixture = await startScriptedFixture(script)
  event(ctx.facts, 'run-start')
  try {
    const turn = await runScriptedTurn({ cwd: ctx.cwd, runHome: ctx.runHome, base: fixture.base, ask: 'Apply the requested change and run its ordinary check.', extraArgv: ['--sovereign'], timeoutMs: 60000 })
    ctx.facts.exitCode = turn.exitCode
    ctx.facts.settled = turn.exitCode === 0 && turn.result?.status === 'completed'
    ctx.facts.runId = String(turn.result?.run_id ?? turn.result?.id ?? '')
    ctx.facts.sessionId = String(turn.result?.session_id ?? '')
    event(ctx.facts, 'run-end', { exitCode: turn.exitCode, status: turn.result?.status })
  } finally {
    await fixture.close()
  }
}
export function execute(cwd: string, args: string[], input?: string): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', args, { cwd, input, encoding: 'utf8', timeout: 10000 })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
export function evaluate(ctx: Context, check: () => Requirement[]): Acceptance {
  const checkStart = new Date().toISOString()
  const before = digest(ctx.cwd)
  let witness: Requirement[]
  try { witness = check() } catch (error) { witness = [{ id: 'runtime', ok: false, witness: String(error) }] }
  const now = snapshot(ctx.cwd)
  witness.push({ id: 'protected-files', ok: Object.entries(ctx.protected).every(([p, hash]) => now[p] === hash), witness: 'Seed checks and manifest retain their hashes.' })
  witness.push({ id: 'allowed-paths', ok: Object.keys(now).every(p => ctx.files.includes(p) || p in ctx.protected), witness: Object.keys(now).join(', ') })
  witness.push({ id: 'settled-run', ok: ctx.facts.settled && ctx.facts.ordinaryCheck, witness: JSON.stringify({ settled: ctx.facts.settled, ordinaryCheck: ctx.facts.ordinaryCheck, exitCode: ctx.facts.exitCode }) })
  witness.push({ id: 'stable-check-tree', ok: before === digest(ctx.cwd), witness: before })
  return { verdict: witness.every(row => row.ok) ? 'accept' : 'refuse', witness, treeDigest: before, checkedPaths: Object.keys(now), checkStart, checkEnd: new Date().toISOString(), runId: ctx.facts.runId, evaluatorVersion: ctx.evaluatorVersion }
}
export function acceptanceCurrent(ctx: Context, accepted: Acceptance): boolean {
  return accepted.verdict === 'accept' && accepted.runId === ctx.facts.runId && accepted.evaluatorVersion === ctx.evaluatorVersion && accepted.treeDigest === digest(ctx.cwd)
}
