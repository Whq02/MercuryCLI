#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'test-result-edges-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
const { TestTool } = await import('../../src/tools/test/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
const { discoverLaunchProfiles } = await import('../../src/integrations/ide/launchProfiles.ts')
const { runPreLaunchTask } = await import('../../src/integrations/ide/launchTasks.ts')
let failures = 0
function check(label: string, ok: boolean, detail: unknown, hint = '') { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(detail)}${!ok && hint ? ` — ${hint}` : ''}`); if (!ok) failures++ }
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }))
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, 'tests', 'sum.test.js'), '')
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  const bin = join(root, 'node_modules', '.bin', 'vitest')
  const report = { numTotalTests: 3, testResults: [{ name: join(root, 'tests/sum.test.js'), status: 'failed', assertionResults: [{ fullName: 'sum fails', title: 'fails', ancestorTitles: ['sum'], status: 'failed', failureMessages: ['expected 7 to be 8'] }, { status: 'passed' }, { status: 'passed' }] }] }
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv.find(a=>a.startsWith('--outputFile=')).slice(13), ${JSON.stringify(JSON.stringify(report))}); process.exit(1);\n`)
  chmodSync(bin, 0o755)
  const result = await runWithCwdOverride(root, () => TestTool.call({ op: 'run', framework: 'vitest' } as never, { getAppState: () => ({}) } as never)) as { data: { outcome: string; result: string }; effect: { outcome: string } }
  check('a parsed failing test is a completed tool result, with the failing counts still red', result.effect.outcome === 'succeeded' && result.data.outcome === 'failed' && result.data.result.includes('2 passed · 1 failed'), result, 'change the vitest run in src/tools/test/TestTool.ts so a parsed failing run returns effect outcome succeeded, data outcome failed and the passed and failed counts')
  const profiles = (await discoverLaunchProfiles(root)).profiles
  check('a JS-only tests directory offers no unittest profile', !profiles.some(p => p.test?.framework === 'unittest'), profiles.map(p => p.label), 'change discoverLaunchProfiles in src/integrations/ide/launchProfiles.ts so a tests directory with only JS files offers no unittest profile')
  const python = join(root, 'python')
  mkdirSync(python)
  writeFileSync(join(python, 'test_sum.py'), 'import unittest\nclass Sum(unittest.TestCase):\n def test_zero(self): self.assertEqual(0,0)\n')
  const py = (await discoverLaunchProfiles(python)).profiles
  check('a Python test file still offers unittest', py.some(p => p.test?.framework === 'unittest'), py.map(p => p.label), 'change discoverLaunchProfiles in src/integrations/ide/launchProfiles.ts so a directory with a Python test file offers a unittest profile')
  const task = await runPreLaunchTask({ label: 'chain', refused: "task 'chain' has dependsOn — Mercury runs one plain task, not a chain" })
  check('a chain refusal does not advise retrying the same refused launch', !task.ran && task.reason.includes('dependsOn') && !task.reason.includes('then launch again'), task, 'change runPreLaunchTask in src/integrations/ide/launchTasks.ts so a refused dependsOn task returns ran false with the dependsOn reason and no advice to launch again')
} finally { rmSync(root, { recursive: true, force: true }) }
if (failures) process.exit(1)
console.log('prove-test-result-edges: GREEN')
