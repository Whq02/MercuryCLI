import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { bootRunner, childEnv, isOutcome } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type WireBlock } from '../lib/scriptedTurn.ts'
import { digest, event, type Change, type Context } from './runtime.ts'

function summary(ctx: Context): { state: string; detail: string; lastEvidence?: { treeDigest?: string } } {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/utils/verification/verificationState.ts')
  const program = `globalThis.MACRO={VERSION:'1.0.0'};const vs=await import(${JSON.stringify(source)});console.log(JSON.stringify(vs.verificationSummary(${JSON.stringify(ctx.cwd)})))`
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: ctx.runHome, MERCURY_VERIFY_EVIDENCE: '1' }
  delete env.MERCURY_HOME
  const result = spawnSync(process.execPath, ['-e', program], { cwd: ctx.cwd, encoding: 'utf8', env, timeout: 10000 })
  if (result.status !== 0) throw new Error(`restart observer failed: ${result.stderr}`)
  return JSON.parse(result.stdout.trim())
}
export async function delayedCheck(ctx: Context, changes: Change[]): Promise<void> {
  const hold = join(ctx.scratch, 'hold')
  mkdirSync(hold)
  const wait = join(ctx.scratch, 'wait.mjs')
  writeFileSync(wait, `import {existsSync,readFileSync,readdirSync} from 'node:fs';import {join} from 'node:path';const root=${JSON.stringify(ctx.runHome)};const hold=${JSON.stringify(hold)};const mode=process.argv[2];const limit=Date.now()+15000;function found(dir){if(!existsSync(dir))return false;return readdirSync(dir,{withFileTypes:true}).some(e=>e.isDirectory()?found(join(dir,e.name)):e.name==='evidence.json'&&JSON.parse(readFileSync(join(dir,e.name),'utf8')).records.some(r=>r.command.includes('OUTCOME_HOLD=')));}while(mode==='ready'?!existsSync(join(hold,'ready')):!found(join(root,'verify'))){if(Date.now()>limit)throw Error('ordering wait expired');await new Promise(r=>setTimeout(r,20));}`)
  const file = changes[0]!
  const calls: WireBlock[] = changes.flatMap(change => [
    { type: 'tool_use' as const, name: 'Read', input: { file_path: join(ctx.cwd, change.path) } },
    { type: 'tool_use' as const, name: 'Edit', input: { file_path: join(ctx.cwd, change.path), old_string: change.before, new_string: change.after } },
  ])
  const checkAt = calls.length
  calls.push(
    { type: 'tool_use', name: 'Bash', input: { command: `OUTCOME_HOLD=${JSON.stringify(hold)} npm test`, cwd: ctx.cwd, run_in_background: true, description: 'Check tree A and hold completion' } },
    { type: 'tool_use', name: 'Bash', input: { command: `node ${JSON.stringify(wait)} ready`, cwd: ctx.cwd, description: 'Wait for the check assertions' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: join(ctx.cwd, file.path), old_string: file.after, new_string: file.after + '\n' } },
    { type: 'tool_use', name: 'Write', input: { file_path: join(hold, 'release'), content: 'release\n' } },
    { type: 'tool_use', name: 'Bash', input: { command: `node ${JSON.stringify(wait)} evidence`, cwd: ctx.cwd, description: 'Wait for the delayed check record' } },
  )
  let fresh = false
  const fixture = await startScriptedFixture(req => {
    if (fresh) {
      if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', cwd: ctx.cwd, description: 'Check the current tree' } }]
      ctx.facts.ordinaryCheck = req.results.every(result => !result.isError)
      return [{ type: 'text', text: 'Done.' }]
    }
    if (req.results.some(result => result.isError)) throw new Error(`ordering tool ${req.step} refused`)
    if (req.step === checkAt) { ctx.facts.effects.firstCandidateHash = digest(ctx.cwd); event(ctx.facts, 'check-A-start') }
    if (req.step === checkAt + 2) event(ctx.facts, 'check-A-assertions-passed')
    if (req.step === checkAt + 3) { ctx.facts.effects.treeB = digest(ctx.cwd); event(ctx.facts, 'tree-B-written') }
    if (req.step === checkAt + 4) event(ctx.facts, 'check-A-released')
    return calls[req.step] ? [calls[req.step]!] : [{ type: 'text', text: 'Done.' }]
  })
  try {
    const first = await runScriptedTurn({ cwd: ctx.cwd, runHome: ctx.runHome, base: fixture.base, ask: 'Run the delayed check ordering.', extraArgv: ['--sovereign'], extraEnv: { MERCURY_VERIFY_EVIDENCE: '1' }, timeoutMs: 60000 })
    if (first.exitCode !== 0) throw new Error(`ordering run exited ${first.exitCode}: ${first.stderr}`)
    event(ctx.facts, 'process-exit')
    ctx.facts.effects.afterRestart = summary(ctx)
    event(ctx.facts, 'restart-observer', ctx.facts.effects.afterRestart)
    fresh = true
    const env = { ...childEnv(ctx.runHome, Number(new URL(fixture.base).port)), MERCURY_VERIFY_EVIDENCE: '1' }
    const runner = bootRunner({ cwd: ctx.cwd, env, extraArgv: ['--sovereign'], asks: 'allow' })
    try {
      await runner.prompt('Run a fresh check on tree B.')
      const result = await runner.waitFor('fresh check', isOutcome, 30000)
      ctx.facts.settled = result?.status === 'completed'
      ctx.facts.runId = String(result?.turn_id ?? '')
      ctx.facts.sessionId = String(result?.session_id ?? '')
    } finally { await runner.stop(5000) }
    ctx.facts.exitCode = await runner.exited
    ctx.facts.effects.afterFresh = summary(ctx)
    event(ctx.facts, 'fresh-check', ctx.facts.effects.afterFresh)
    ctx.facts.effects.deliveredBytes = readFileSync(join(ctx.cwd, file.path), 'utf8') === file.after + '\n'
  } finally { await fixture.close() }
}
