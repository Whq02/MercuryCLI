#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'describe-rerun-'))
process.env.MERCURY_CONFIG_DIR = path.join(home, 'home')
process.env.MERCURY_BARE = '1'
const runners = await import('../../src/integrations/ide/projectRunners.ts')
const { TestTool } = await import('../../src/tools/test/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
let failures = 0
function check(name: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}${ok ? '' : ' | fix runRunnerProfile and rerunRunnerFailures in src/integrations/ide/projectRunners.ts (rerun selection, counts, no-match verdict) or the rerunFailed op of the Test tool in src/tools/test/TestTool.ts'}`)
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
      const file = runner === 'vitest' ? 'sum.test.mjs' : 'sum.test.js'
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
      check(`${runner}: zero selected tests is a no-match record with zero counts, never an all-clear and never a failure`, vanished.state === 'ok' && vanished.record.verdict === 'no-match' && vanished.record.counts.passed === 0 && vanished.record.counts.failed === 0 && (vanished.record.verdictNote ?? '').startsWith('no test matched rerun-failed — ') && (vanished.record.verdictNote ?? '').includes('run the full profile to refresh its case names'), vanished.state === 'ok' ? { verdict: vanished.record.verdict, counts: vanished.record.counts, note: vanished.record.verdictNote } : vanished)
      await runners.runRunnerProfile(profile, { from: root })
      writeFileSync(path.join(root, file), readFileSync(path.join(root, file), 'utf8').replaceAll('adds zero', 'renamed zero'))
      if (live) {
        const result = await runWithCwdOverride(root, () => TestTool.call({ op: 'rerunFailed' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string } }
        check(`${runner}: the Test tool reports the empty selection as no-change with the runner's own words, not as failed`, result.data.outcome === 'no-change' && result.data.result.includes('no test matched rerun-failed'), result.data)
      }
    }
  }
  const cargoRoot = path.join(home, 'cargo-multi-fail')
  const cargoBinDir = path.join(cargoRoot, 'bin')
  mkdirSync(cargoBinDir, { recursive: true })
  writeFileSync(path.join(cargoRoot, 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n')
  const cargoArgvFile = path.join(cargoRoot, 'argv.json')
  const cargoStandIn = path.join(cargoBinDir, 'cargo')
  writeFileSync(cargoStandIn, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(cargoArgvFile)}, JSON.stringify(args));
const tests = [
  { name: 'tests::fail_a', ok: false },
  { name: 'tests::fail_a_extra', ok: true },
  { name: 'tests::fail_b', ok: false },
  { name: 'tests::ok_c', ok: true },
];
const sep = args.indexOf('--');
const harness = sep === -1 ? [] : args.slice(sep + 1);
const exact = harness.includes('--exact');
const filters = sep === -1 ? args.slice(1).filter(a => !a.startsWith('-')) : harness.filter(a => !a.startsWith('-'));
const selected = filters.length === 0 ? tests : tests.filter(t => filters.some(f => exact ? t.name === f : t.name.includes(f)));
let passed = 0, failed = 0;
console.log('running ' + selected.length + ' tests');
for (const t of selected) {
  if (t.ok) passed++; else failed++;
  console.log('test ' + t.name + ' ... ' + (t.ok ? 'ok' : 'FAILED'));
}
console.log('test result: ' + (failed ? 'FAILED' : 'ok') + '. ' + passed + ' passed; ' + failed + ' failed; 0 ignored; 0 measured; ' + (tests.length - selected.length) + ' filtered out; finished in 0.00s');
process.exit(failed ? 101 : 0);
`)
  chmodSync(cargoStandIn, 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${cargoBinDir}${path.delimiter}${savedPath ?? ''}`
  try {
    const cargoProfile = runners.discoverRunnerProfiles(cargoRoot).profiles.find(p => p.runner === 'cargo' && p.kind === 'test')!
    const cargoRun = await runners.runRunnerProfile(cargoProfile, { from: cargoRoot })
    check('cargo: full run records both failures', cargoRun.state === 'ok' && JSON.stringify(cargoRun.record.failures) === JSON.stringify(['tests::fail_a', 'tests::fail_b']), cargoRun.state === 'ok' ? cargoRun.record.failures : cargoRun)
    if (cargoRun.state === 'ok') {
      const cargoRerun = await runners.rerunRunnerFailures(cargoRun.record, { from: cargoRoot })
      const cargoRerunArgv = JSON.parse(readFileSync(cargoArgvFile, 'utf8')) as string[]
      check('cargo: rerun selects all failed tests exactly without sibling prefix matches', cargoRerun.state === 'ok' && cargoRerun.record.counts.failed === 2 && cargoRerun.record.counts.passed === 0 && JSON.stringify(cargoRerun.record.failures) === JSON.stringify(['tests::fail_a', 'tests::fail_b']), cargoRerun.state === 'ok' ? { counts: cargoRerun.record.counts, failures: cargoRerun.record.failures, argv: cargoRerunArgv } : cargoRerun)
    }
  } finally {
    process.env.PATH = savedPath
  }
} finally { rmSync(home, { recursive: true, force: true }) }
if (failures) process.exit(1)
console.log('prove-describe-rerun: GREEN')
