#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'describe-rerun-'))
process.env.MERCURY_CONFIG_DIR = path.join(home, 'home')
process.env.MERCURY_BARE = '1'
const runners = await import('../../src/services/ide/projectRunners.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
let failures = 0
function check(name: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`)
  if (!ok) failures++
}
try {
  for (const runner of ['vitest', 'jest'] as const) {
    for (const live of [false, true]) {
      const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
      if (live && !modules) { console.log(`SKIP live ${runner}: MERCURY_PROOF_RUNNER_MODULES not set`); continue }
      const root = path.join(home, `${runner}-${live ? 'live' : 'standin'}`)
      mkdirSync(root)
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, devDependencies: { [runner]: '*' } }))
      const file = runner === 'vitest' ? 'sum.test.mjs' : 'sum.test.cjs'
      writeFileSync(path.join(root, file), `${runner === 'vitest' ? "import {describe,it,expect} from 'vitest';" : ''}
describe('sum', () => {
  describe('nested [suite]', () => {
    it('adds zero (wrong on purpose)', () => { expect(7).toBe(8) })
    it('adds zero (wrong on purpose) suffix', () => { expect(7).toBe(7) })
  })
  it('adds zero (wrong on purpose)', () => { expect(7).toBe(7) })
})
`)
      if (live) symlinkSync(modules!, path.join(root, 'node_modules'))
      else {
        mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
        const bin = path.join(root, 'node_modules', '.bin', runner)
        writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
const names = [['sum','nested [suite]','adds zero (wrong on purpose)'],['sum','nested [suite]','adds zero (wrong on purpose) suffix'],['sum','adds zero (wrong on purpose)']];
const pattern = args.includes('-t') ? new RegExp(args[args.indexOf('-t')+1]) : null;
const assertionResults = names.map((parts,i) => ({title:parts.at(-1),ancestorTitles:parts.slice(0,-1),fullName:parts.join(' '),status:pattern && !pattern.test(parts.join(${JSON.stringify(runner === 'vitest' ? ' > ' : ' ')})) ? 'pending' : i === 0 ? 'failed' : 'passed',failureMessages:i === 0 ? ['expected 7 to be 8'] : []}));
fs.writeFileSync(args.find(a=>a.startsWith('--outputFile=')).slice(13),JSON.stringify({numTotalTests:3,testResults:[{name:${JSON.stringify(path.join(root, file))},assertionResults}]}));
process.exit(assertionResults.some(a=>a.status==='failed') ? 1 : 0);
`)
        chmodSync(bin, 0o755)
      }
      const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === runner)!
      const run = await runners.runRunnerProfile(profile, { from: root })
      check(`${runner} ${live ? 'live' : 'report fixture'}: full run has one failure`, run.state === 'ok' && run.record.counts.failed === 1, run.state === 'ok' ? run.record.counts : run)
      if (run.state !== 'ok') continue
      const rerun = await runners.rerunRunnerFailures(run.record, { from: root })
      check(`${runner}: rerun selects exactly the describe-wrapped failure, not the sibling title`, rerun.state === 'ok' && rerun.record.counts.failed === 1 && rerun.record.counts.passed === 0 && rerun.record.counts.skipped === 2, rerun.state === 'ok' ? { counts: rerun.record.counts, command: rerun.record.command } : rerun)
      const vanished = await runners.rerunRunnerFailures({ ...run.record, failures: ['nothing_here'], cases: [] }, { from: root })
      check(`${runner}: zero selected tests is refused, never an all-clear`, vanished.state === 'unavailable' && vanished.reason.includes('the rerun selected no test'), vanished)
      await runners.runRunnerProfile(profile, { from: root })
      writeFileSync(path.join(root, file), readFileSync(path.join(root, file), 'utf8').replaceAll('adds zero', 'renamed zero'))
      if (live) {
        const result = await runWithCwdOverride(root, () => TestTool.call({ op: 'rerunFailed' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string } }
        check(`${runner}: the Test tool reports the empty selection as failed`, result.data.outcome === 'failed' && result.data.result.includes('the rerun selected no test'), result.data)
      }
    }
  }
} finally { rmSync(home, { recursive: true, force: true }) }
if (failures) process.exit(1)
console.log('prove-describe-rerun: GREEN')
