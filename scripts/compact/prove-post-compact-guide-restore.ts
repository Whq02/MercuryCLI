#!/usr/bin/env bun
// gate-watch: src/services/compact/compact.ts src/services/instructions/** src/utils/config/globalConfig.ts src/utils/fileStateCache.ts src/state/AppStateStore.ts src/bootstrap/state.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'post-compact-guide-')))
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const bootstrap = await import(${JSON.stringify(join(repo, 'src/bootstrap/state.ts'))})
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(${JSON.stringify(join(repo, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
const { getDefaultAppState } = await import(${JSON.stringify(join(repo, 'src/state/AppStateStore.ts'))})
const { createFileStateCacheWithSizeLimit } = await import(${JSON.stringify(join(repo, 'src/utils/fileStateCache.ts'))})
const { getInstructionFiles, isInstructionFilePath } = await import(${JSON.stringify(join(repo, 'src/services/instructions/engine.ts'))})
const compact = await import(${JSON.stringify(join(repo, 'src/services/compact/compact.ts'))})
const cwd = process.cwd()
const composed = (await getInstructionFiles()).map(f => f.path)
let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>) }
const ctx = {
  abortController: new AbortController(),
  options: { commands: [], tools: [], mainLoopModel: 'claude-opus-5', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => appState,
  setAppState: (f: (prev: never) => never): void => { appState = f(appState as never) as unknown as Record<string, unknown> },
  messages: [],
  readFileState: createFileStateCacheWithSizeLimit(100),
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
  agentId: undefined,
}
const read = (process.env.DRV_READ ?? '').split(':').filter(Boolean).map(rel => join(cwd, rel))
const ledger: Record<string, { content: string; timestamp: number }> = {}
for (const [i, path] of read.entries()) ledger[path] = { content: 'read', timestamp: 1000 + i }
const restored = (await compact.createPostCompactFileAttachments(ledger, ctx as never, 20, []))
  .map(m => (m as { attachment: { filename?: string } }).attachment.filename ?? '')
writeFileSync(process.argv[2]!, JSON.stringify({
  composed,
  restored,
  classified: Object.fromEntries(read.map(p => [p, isInstructionFilePath(p)])),
}))
`)

type Drive = { composed: string[]; restored: string[]; classified: Record<string, boolean> }

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

let projects = 0
function project(layout: Record<string, string>): string {
  const root = join(scratch, `project-${++projects}`)
  for (const [rel, content] of Object.entries(layout)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

function drive(cwd: string, read: string[], settings?: object): Drive {
  const home = mkdtempSync(join(scratch, 'home-'))
  seedFirstRun(home, [cwd])
  if (settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  const result = join(home, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd,
    env: { ...env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DRV_READ: read.join(':') },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  return JSON.parse(readFileSync(result, 'utf8')) as Drive
}

const has = (list: string[], root: string, rel: string): boolean => list.includes(join(root, rel))

try {
  console.log('§1 both guides at the root: MERCURY.md composes, a read of AGENTS.md comes back after a compaction')
  const both = project({ 'MERCURY.md': 'native-guide\n', 'AGENTS.md': 'shared-guide\n', 'notes.md': 'notes\n' })
  const s1 = drive(both, ['MERCURY.md', 'AGENTS.md', 'notes.md'])
  check('MERCURY.md composed, AGENTS.md did not', has(s1.composed, both, 'MERCURY.md') && !has(s1.composed, both, 'AGENTS.md'), s1.composed.join(', '))
  check('the composed MERCURY.md is left to the prompt (not restored)', !has(s1.restored, both, 'MERCURY.md'), s1.restored.join(', '))
  check('an ordinary file read is restored', has(s1.restored, both, 'notes.md'), s1.restored.join(', '))
  check('the AGENTS.md read is restored: nothing else carries it', has(s1.restored, both, 'AGENTS.md'), s1.restored.join(', '))
  check('AGENTS.md beside MERCURY.md is not an instruction file', s1.classified[join(both, 'AGENTS.md')] === false)

  console.log('§2 a nested AGENTS.md under a root MERCURY.md is an ordinary file')
  const guided = project({ 'MERCURY.md': 'native-guide\n', 'sub/AGENTS.md': 'nested-shared\n', 'sub/file.ts': '\n' })
  const s2 = drive(guided, ['sub/AGENTS.md', 'sub/file.ts'])
  check('its read is restored', has(s2.restored, guided, 'sub/AGENTS.md'), s2.restored.join(', '))
  check('the file beside it is restored too', has(s2.restored, guided, 'sub/file.ts'))

  console.log('§3 a project whose guides are AGENTS.md files: the composed and the on-touch ones are left to their own roads')
  const shared = project({ 'AGENTS.md': 'root-shared\n', 'notes.md': 'notes\n', 'sub/AGENTS.md': 'nested-shared\n', 'mixed/MERCURY.md': 'nested-native\n', 'mixed/AGENTS.md': 'nested-shared\n' })
  const s3 = drive(shared, ['AGENTS.md', 'notes.md', 'sub/AGENTS.md', 'mixed/AGENTS.md', 'mixed/MERCURY.md'])
  check('the root AGENTS.md composed', has(s3.composed, shared, 'AGENTS.md'), s3.composed.join(', '))
  check('the composed AGENTS.md is not restored (the prompt carries it)', !has(s3.restored, shared, 'AGENTS.md'), s3.restored.join(', '))
  check('a nested AGENTS.md that attaches on touch is not restored', !has(s3.restored, shared, 'sub/AGENTS.md'), s3.restored.join(', '))
  check('a nested MERCURY.md is not restored', !has(s3.restored, shared, 'mixed/MERCURY.md'), s3.restored.join(', '))
  check('the AGENTS.md beside a nested MERCURY.md is restored: that directory loads MERCURY.md alone', has(s3.restored, shared, 'mixed/AGENTS.md'), s3.restored.join(', '))
  check('the ordinary file is restored', has(s3.restored, shared, 'notes.md'))

  console.log('§4 the native profile: AGENTS.md is an ordinary file everywhere')
  const s4 = drive(shared, ['AGENTS.md', 'sub/AGENTS.md'], { briefs: { profile: 'native' } })
  check('nothing composed from the project', s4.composed.every(p => !p.startsWith(shared)), s4.composed.join(', '))
  check('both AGENTS.md reads are restored', has(s4.restored, shared, 'AGENTS.md') && has(s4.restored, shared, 'sub/AGENTS.md'), s4.restored.join(', '))

  console.log("§5 a MERCURY.local.md beside the project's AGENTS.md: both compose, and both reads are left to the prompt")
  const personal = project({ 'MERCURY.local.md': 'local-layer\n', 'AGENTS.md': 'shared-guide\n', 'notes.md': 'notes\n', 'sub/MERCURY.local.md': 'nested-local\n', 'sub/AGENTS.md': 'nested-shared\n' })
  const s5 = drive(personal, ['MERCURY.local.md', 'AGENTS.md', 'notes.md', 'sub/AGENTS.md', 'sub/MERCURY.local.md'])
  check('AGENTS.md and the local file both composed', has(s5.composed, personal, 'AGENTS.md') && has(s5.composed, personal, 'MERCURY.local.md'), s5.composed.join(', '))
  check('the composed AGENTS.md is not restored (the prompt carries it)', !has(s5.restored, personal, 'AGENTS.md'), s5.restored.join(', '))
  check('the composed local file is not restored', !has(s5.restored, personal, 'MERCURY.local.md'), s5.restored.join(', '))
  check('the ordinary file is restored', has(s5.restored, personal, 'notes.md'), s5.restored.join(', '))
  check('AGENTS.md beside a local file is an instruction file', s5.classified[join(personal, 'AGENTS.md')] === true)
  check('a nested AGENTS.md beside a nested local file attaches on touch: not restored', !has(s5.restored, personal, 'sub/AGENTS.md'), s5.restored.join(', '))
  check('the nested local file is not restored either', !has(s5.restored, personal, 'sub/MERCURY.local.md'), s5.restored.join(', '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`post-compact-guide-restore: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
