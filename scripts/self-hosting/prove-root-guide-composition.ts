#!/usr/bin/env bun
// gate-watch: src/utils/config/globalConfig.ts src/context.ts src/services/instructions/** src/utils/attachments/nestedMemory.ts src/utils/fileStateCache.ts src/Tool.ts
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'one-root-guides-')))
const project = join(scratch, 'project')
const outside = join(scratch, 'outside')
for (const dir of [join(project, 'sub'), join(outside, 'sub')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(project, 'CLAUDE.md'), '@AGENTS.md\n')
writeFileSync(join(project, 'AGENTS.md'), 'explicit-guide-needle\n')
writeFileSync(join(project, 'sub', 'MERCURY.md'), 'nested-guide-needle\n')
writeFileSync(join(project, 'sub', 'file.ts'), 'export const answer = 42\n')
writeFileSync(join(outside, 'MERCURY.md'), 'outside-guide-needle\n')
writeFileSync(join(outside, 'sub', 'MERCURY.md'), 'outside-nested-needle\n')
writeFileSync(join(outside, 'sub', 'file.ts'), 'export const answer = 42\n')
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import(${JSON.stringify(join(repo, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
const { getEmptyToolPermissionContext } = await import(${JSON.stringify(join(repo, 'src/Tool.ts'))})
const { getInstructionFiles, composeInstructionPrompt, getInstructionBundle, getMaxMemoryCharacterCount, getLargeMemoryFiles } = await import(${JSON.stringify(join(repo, 'src/services/instructions/engine.ts'))})
const { getUserContext, isInstructionDiscoveryDisabled } = await import(${JSON.stringify(join(repo, 'src/context.ts'))})
const { getNestedMemoryAttachmentsForFile } = await import(${JSON.stringify(join(repo, 'src/utils/attachments/nestedMemory.ts'))})
const { createFileStateCacheWithSizeLimit } = await import(${JSON.stringify(join(repo, 'src/utils/fileStateCache.ts'))})
const files = await getInstructionFiles()
const composed = composeInstructionPrompt(files)
const bundle = await getInstructionBundle()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const touched = process.env.DRV_TOUCH ? await getNestedMemoryAttachmentsForFile(process.env.DRV_TOUCH, context as never, state) : []
writeFileSync(process.argv[2]!, JSON.stringify({ paths: files.map(f => f.path), composed, resolution: bundle.resolution.resolved, entries: bundle.entries.map(e => ({ path: e.path, root: e.root, origin: e.origin })), cap: getMaxMemoryCharacterCount(), large: getLargeMemoryFiles(files).map(f => f.path), disabled: isInstructionDiscoveryDisabled(), user: (await getUserContext()).instructions ?? '', touched: touched.map(a => a.path) }))
`)
let passed = 0
let failed = 0
function check(label: string, ok: boolean): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
function drive(options: { touch?: string; bare?: boolean; retired?: boolean } = {}) {
  const home = mkdtempSync(join(scratch, 'home-'))
  seedFirstRun(home, [project])
  const result = join(home, 'result.json')
  if (options.retired) writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { additionalDirectories: [outside] } }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], { cwd: project, env: { ...env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ...(options.bare ? { MERCURY_BARE: '1' } : {}), ...(options.touch ? { DRV_TOUCH: options.touch } : {}) }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60_000 })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  return JSON.parse(readFileSync(result, 'utf8')) as { paths: string[]; composed: string; resolution: string; entries: Array<{ path: string; root?: string; origin: string }>; cap: number; large: string[]; disabled: boolean; user: string; touched: string[] }
}
try {
  const plain = drive()
  check('the default profile is native', plain.resolution === 'native')
  check('a compatibility guide never auto-loads as a native root guide', !plain.composed.includes('explicit-guide-needle'))
  writeFileSync(join(project, 'MERCURY.local.md'), '@CLAUDE.md\n')
  const explicit = drive()
  check('an explicit native import composes the compatibility guide exactly once', explicit.composed.split('explicit-guide-needle').length === 2)
  check('the starting-folder entry is root-stamped', explicit.entries.some(e => e.path === join(project, 'MERCURY.local.md') && e.root === project && e.origin === 'project-walk'))
  unlinkSync(join(project, 'MERCURY.local.md'))
  const native = join(project, 'MERCURY.md')
  writeFileSync(native, 'native-root-needle\n')
  const nested = drive({ touch: join(project, 'sub', 'file.ts') })
  check('the native starting-folder guide reaches user context', nested.user.includes('native-root-needle'))
  check('the boot walk does not descend into nested guides', !nested.paths.includes(join(project, 'sub', 'MERCURY.md')))
  check('touching a file under the starting folder attaches its nested guide', nested.touched.includes(join(project, 'sub', 'MERCURY.md')))
  const retired = drive({ retired: true, touch: join(outside, 'sub', 'file.ts') })
  check('a retired saved directory never becomes an instruction root', !retired.composed.includes('outside-guide-needle') && !retired.user.includes('outside-guide-needle'))
  check('nor does touching it load a nested guide', retired.touched.length === 0)
  check('every project guide keeps the starting folder as its root', retired.entries.filter(e => e.origin === 'project-walk').every(e => e.root === project))
  const bare = drive({ bare: true, retired: true })
  check('bare mode stays discovery-free despite an old saved directory', bare.disabled && bare.user === '')
  const largeGuide = `native-root-needle\n${'x'.repeat(plain.cap + 1)}\n`
  writeFileSync(native, largeGuide)
  const big = drive()
  check('a large starting-folder guide is reported, never truncated', big.large.includes(native) && big.composed.length > big.cap && big.composed.includes(largeGuide.trim()) && big.user.includes(largeGuide.trim()))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`root-guide-composition: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
