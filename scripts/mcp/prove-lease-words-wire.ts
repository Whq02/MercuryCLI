#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-lease-words-wire')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'lease-words-wire-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'x.txt'), 'x\n')
writeFileSync(join(work, 'y.txt'), 'y\n')
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'lease-words-probe'
const seen: Record<string, SeenResult> = {}
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_claim', input: { paths: ['src/a.ts'], reason: 'the model adds a reason' } }]
    case 1:
      if (last) seen.claimPaths = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_claim', input: { globs: ['src/b.ts'] } }]
    case 2:
      if (last) seen.claimGlobs = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_claim', input: { reason: 'no list at all' } }]
    case 3:
      if (last) seen.claimNone = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_take', input: { paths: ['x.txt'] } }]
    case 4:
      if (last) seen.takeX = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_release', input: { paths: ['x.txt'] } }]
    case 5:
      if (last) seen.releasePaths = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_take', input: { paths: ['y.txt'] } }]
    case 6:
      if (last) seen.takeY = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_release', input: { globs: ['y.txt'] } }]
    case 7:
      if (last) seen.releaseGlobs = last
      return [{ type: 'tool_use', name: 'mcp__mercury__lease_list', input: {} }]
    default:
      if (req.step === 8 && last) seen.listAfter = last
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({
    runHome: join(scratch, 'home'),
    cwd: work,
    base: fixture.base,
    ask: ASK,
    timeoutMs: 120_000,
    extraArgv: ['--dangerously-bypass-permissions'],
  })
} finally {
  await fixture.close()
}

const show = (label: string, r: SeenResult | undefined): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  for (const line of r.text.split('\n').slice(0, 6)) console.log(`│ ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`)
}
const parsed = (r: SeenResult | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(r?.text ?? '') as Record<string, unknown>
  } catch {
    return {}
  }
}
for (const [k, v] of Object.entries(seen)) show(k, v)

const reachesTheVerb = (r: SeenResult | undefined): boolean => r !== undefined && !r.isError && parsed(r).reason === 'NOT_IN_TEAM'
tally.section('A. on the built product, a claim reaches the verb under either spelling')
tally.check('A1 a claim sent as paths, with the reason the model adds, is no longer refused: it answers the verb’s own solo no-op', reachesTheVerb(seen.claimPaths), seen.claimPaths?.text.slice(0, 300))
tally.check('A2 a claim sent as globs answers the same', reachesTheVerb(seen.claimGlobs), seen.claimGlobs?.text.slice(0, 300))
tally.check('A3 a claim with no list is refused, naming both spellings', seen.claimNone !== undefined && seen.claimNone.isError && /\bpaths\b/.test(seen.claimNone.text) && /\bglobs\b/.test(seen.claimNone.text), seen.claimNone?.text.slice(0, 300))
tally.check('A4 the refusal is the tool’s own, not the schema’s', seen.claimNone !== undefined && !/Invalid arguments for tool/.test(seen.claimNone.text), seen.claimNone?.text.slice(0, 300))

tally.section('B. a release releases under either spelling')
tally.check('B1 the exact project lease on x.txt is taken', seen.takeX !== undefined && !seen.takeX.isError && parsed(seen.takeX).ok === true, seen.takeX?.text.slice(0, 300))
tally.check('B2 a release sent as paths releases it', seen.releasePaths !== undefined && !seen.releasePaths.isError && parsed(seen.releasePaths).released === true, seen.releasePaths?.text.slice(0, 300))
tally.check('B3 the exact project lease on y.txt is taken', seen.takeY !== undefined && !seen.takeY.isError && parsed(seen.takeY).ok === true, seen.takeY?.text.slice(0, 300))
tally.check('B4 a release sent as globs releases the named project lease', seen.releaseGlobs !== undefined && !seen.releaseGlobs.isError && parsed(seen.releaseGlobs).released === true, seen.releaseGlobs?.text.slice(0, 300))
tally.check('B5 no project lease is left on the list', seen.listAfter !== undefined && !seen.listAfter.isError && Array.isArray(parsed(seen.listAfter).leases) && (parsed(seen.listAfter).leases as unknown[]).length === 0, seen.listAfter?.text.slice(0, 300))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
