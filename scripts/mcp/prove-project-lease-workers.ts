#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult, type WireBlock } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-project-lease-workers')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'project-lease-workers-'))
const seen = new Map<string, SeenResult>()
const stages = { alpha: 0, beta: 0 }
let runDir = ''
let betaDone = false
let genericLaunched = false
const nap = (): WireBlock[] => [{ type: 'tool_use', name: 'Sleep', input: { seconds: 0.1 } }]
const call = (name: string, input: Record<string, unknown>): WireBlock[] => [{ type: 'tool_use', name: `mcp__mercury__${name}`, input }]
const done = (): WireBlock[] => [{ type: 'text', text: 'done' }]
const manifest = (): any => {
  try { return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) } catch { return null }
}
const fixture = await startScriptedFixture(req => {
  const last = req.results.at(-1)
  if (req.opening.includes('lease-worker-generic')) {
    if (!last) return call('lease_take', { paths: ['generic.ts'] })
    seen.set('generic', last)
    return done()
  }
  if (req.opening.includes('lease-worker-alpha')) {
    if (stages.alpha === 0) { stages.alpha++; return call('lease_take', { paths: ['alpha.ts', 'shared.ts'] }) }
    if (!seen.has('alpha') && last) seen.set('alpha', last)
    return betaDone ? done() : nap()
  }
  if (req.opening.includes('lease-worker-beta')) {
    switch (stages.beta) {
      case 0: stages.beta++; return call('lease_take', { paths: ['beta.ts'] })
      case 1:
        if (!seen.has('beta') && last) seen.set('beta', last)
        if (!seen.has('alpha')) return nap()
        stages.beta++; return call('lease_take', { paths: ['shared.ts'] })
      case 2:
        if (last) seen.set('conflict', last)
        stages.beta++; return call('lease_release', { paths: ['alpha.ts', 'shared.ts'], project: true })
      case 3:
        if (last) seen.set('release', last)
        stages.beta++; return call('lease_list', { project: true })
      case 4:
        if (last) seen.set('list', last)
        stages.beta++; return call('lease_take', { paths: [] })
      default:
        if (!seen.has('malformed') && last) seen.set('malformed', last)
        betaDone = true
        return done()
    }
  }
  if (req.opening !== 'project-lease-workers') return done()
  if (req.step === 0) return [{ type: 'tool_use', name: 'Workflow', input: { script: "export const meta = { name: 'lease-workers', description: 'project lease holders' }\nreturn await Promise.all([agent('lease-worker-alpha', { label: 'alpha' }), agent('lease-worker-beta', { label: 'beta' })])" } }]
  if (!runDir) {
    if (last) seen.set('launch', last)
    const script = /^Script file: (.+)$/m.exec(last?.text ?? '')?.[1]
    if (script) runDir = dirname(script)
    else return done()
  }
  if (manifest()?.status === 'running') return nap()
  if (!genericLaunched) {
    genericLaunched = true
    return [{ type: 'tool_use', name: 'Agent', input: { description: 'Check a lease owner', prompt: 'lease-worker-generic', run_in_background: false } }]
  }
  if (!seen.has('genericReceipt') && last) seen.set('genericReceipt', last)
  return seen.has('generic') ? done() : nap()
})
console.log(`build under proof: ${DIST}`)
try {
  const turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: join(scratch, 'work'), base: fixture.base, ask: 'project-lease-workers', timeoutMs: 120_000, extraArgv: ['--sovereign'] })
  tally.check('the two-worker journey settles', turn.exitCode === 0 && manifest()?.status === 'completed', `${turn.stderr.slice(-500)}; ${seen.get('launch')?.text.slice(0, 250)}; status=${manifest()?.status}`)
  const parse = (key: string): any => { try { return JSON.parse(seen.get(key)?.text ?? '') } catch { return null } }
  const a = parse('alpha')?.leases?.find((l: any) => l.path === 'alpha.ts')?.holder
  const b = parse('beta')?.leases?.find((l: any) => l.path === 'beta.ts')?.holder
  const agents = manifest()?.agents ?? []
  const aId = agents.find((a: any) => a.label === 'alpha')?.agentId
  const bId = agents.find((a: any) => a.label === 'beta')?.agentId
  tally.check('both workers have distinct execution ids', !!aId && !!bId && aId !== bId, JSON.stringify(agents).slice(0, 1200))
  tally.check('alpha owns its lease under its execution id', !!a && a.agentId === aId && a.agentId !== 'main', JSON.stringify(a))
  tally.check('beta owns its lease under its execution id', !!b && b.agentId === bId && b.agentId !== 'main', JSON.stringify(b))
  tally.check('the workers share a session and process, not an identity', !!a && !!b && a.sessionId === b.sessionId && a.pid === b.pid && a.agentId !== b.agentId, JSON.stringify({ a, b }))
  const conflict = parse('conflict')
  tally.check('a competing claim refuses and names alpha', conflict?.ok === false && conflict.conflict?.holder?.agentId === aId && conflict.message?.includes(aId), seen.get('conflict')?.text)
  tally.check('beta cannot release alpha files', parse('release')?.released === false && parse('release')?.agentId === bId, seen.get('release')?.text)
  const leases = parse('list')?.leases ?? []
  tally.check('alpha still holds both files after beta releases', ['alpha.ts', 'shared.ts'].every(path => leases.some((l: any) => l.path === path && l.holder.agentId === aId)), JSON.stringify(leases))
  tally.check('malformed lease input returns an error', seen.get('malformed')?.isError === true, seen.get('malformed')?.text)
  const generic = parse('generic')?.leases?.find((l: any) => l.path === 'generic.ts')?.holder
  const genericId = /agentId: (\S+)/.exec(seen.get('genericReceipt')?.text ?? '')?.[1]
  tally.check('an ordinary in-process subagent owns its lease under its own id', !!genericId && generic?.agentId === genericId && genericId !== 'main', JSON.stringify({ generic, receipt: seen.get('genericReceipt')?.text }))
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
