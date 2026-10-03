#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-project-lease-paths')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'project-lease-paths-'))
const work = join(scratch, 'work')
mkdirSync(join(work, '.mercury', 'handoffs'), { recursive: true })
symlinkSync('.mercury/project-leases.sqlite', join(work, 'ledger-link'))
const ordinary = ['report.ts', '.mercury/handoffs/result.json', '.mercury/project-leases.sqlite-copy', '.mercury/notes.json']
const storage = ['.mercury/project-leases.sqlite', '.mercury/project-leases.sqlite-journal', '.mercury/project-leases.sqlite-wal', '.mercury/project-leases.sqlite-shm', 'ledger-link']
const cases = [...ordinary, ...storage]
const seen = new Map<string, SeenResult>()
let index = 0
const fixture = await startScriptedFixture(req => {
  if (req.opening !== 'project-lease-paths') return [{ type: 'text', text: 'done' }]
  if (req.results.length && index > 0) seen.set(cases[index - 1]!, req.results.at(-1)!)
  const file = cases[index++]
  return file === undefined
    ? [{ type: 'text', text: 'done' }]
    : [{ type: 'tool_use', name: 'mcp__mercury__lease_take', input: { paths: [file] } }]
})
console.log(`build under proof: ${DIST}`)
try {
  const turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: 'project-lease-paths', extraArgv: ['--sovereign'], timeoutMs: 120_000 })
  tally.check('the tool journey settles', turn.exitCode === 0, turn.stderr.slice(-500))
  for (const file of ordinary) {
    const result = seen.get(file)
    tally.check(`${file} can be leased`, result !== undefined && !result.isError && /"ok":\s*true/.test(result.text), result?.text.slice(0, 350))
  }
  for (const file of storage) {
    const result = seen.get(file)
    tally.check(`${file} names the store refusal`, result?.isError === true && result.text.includes(`${file} is the lease store itself and cannot be leased`), result?.text.slice(0, 350))
  }
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
