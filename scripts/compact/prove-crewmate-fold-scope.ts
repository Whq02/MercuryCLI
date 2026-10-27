#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'crewmate-fold-scope-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { getGitStatus, getSystemContext, getUserContext } = await import('../../src/context.ts')
const { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } = await import('../../src/bootstrap/state.ts')
const { runPostCompactCleanup } = await import('../../src/services/compact/postCompactCleanup.ts')

const held = (): string =>
  [getGitStatus.cache.has(undefined) ? 'git' : '', getSystemContext.cache.has(undefined) ? 'system' : '', getUserContext.cache.has(undefined) ? 'user' : ''].filter(Boolean).join('+') || 'none'
const SECTION = 'crewmate-fold-scope-probe'
const sectionHeld = (): boolean => getSystemPromptSectionCache().get(SECTION)?.value === 'the main conversation\'s cached section'
const prime = async (): Promise<void> => {
  await getGitStatus()
  await getSystemContext()
  await getUserContext()
  setSystemPromptSectionCacheEntry(SECTION, 'the main conversation\'s cached section', 'k1')
}

section("§1 a crewmate's fold tagged with its parent's query source touches only the crewmate's state")
{
  await prime()
  check('the main conversation memoises the git status, the system context, the user context and a prompt section', held() === 'git+system+user' && sectionHeld(), `${held()} · section ${sectionHeld()}`)
  runPostCompactCleanup({ querySource: 'main_thread', agentId: 'aprobe01' })
  check("a crewmate launched by the main thread (its query source is main_thread) folds without clearing the main conversation's memos", held() === 'git+system+user', held())
  check("…and without clearing the main conversation's system-prompt section cache", sectionHeld())
  runPostCompactCleanup({ querySource: 'sdk', agentId: 'aprobe02' })
  check("a crewmate launched by a headless session (its query source is sdk) folds the same way", held() === 'git+system+user' && sectionHeld(), `${held()} · section ${sectionHeld()}`)
  runPostCompactCleanup({ querySource: 'agent:builtin:mercury-crew', agentId: 'aprobe03' })
  check('a crewmate tagged with its own agent source folds the same way', held() === 'git+system+user' && sectionHeld(), `${held()} · section ${sectionHeld()}`)
}

section('§2 the main conversation\'s own fold still clears what a fold invalidates')
{
  runPostCompactCleanup({ querySource: 'main_thread' })
  check('the main fold (no agent id) clears the three memos', held() === 'none', held())
  check('…and the section cache', !sectionHeld())
  await prime()
  runPostCompactCleanup()
  check('/compact and /clear (no scope at all) clear them the same way', held() === 'none' && !sectionHeld(), `${held()} · section ${sectionHeld()}`)
  await prime()
  runPostCompactCleanup('sdk')
  check('the headless main fold (a bare sdk source) clears them too', held() === 'none' && !sectionHeld(), `${held()} · section ${sectionHeld()}`)
}

section('§3 a launched crewmate carries its own query source and never restamps the session metadata')
{
  const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const launch = /const querySource =([^]*?)\n\n/.exec(agentTool)?.[1] ?? ''
  check('AgentTool derives the crewmate\'s query source from the agent definition alone', launch.includes('getQuerySourceForAgent(') && !launch.includes('options.querySource'), launch.trim())
  const resume = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
  check('a resumed crewmate derives it the same way', resume.includes('getQuerySourceForAgent('))
  const { getQuerySourceForAgent } = await import('../../src/utils/promptCategory.ts')
  check('a built-in crewmate is an agent source', getQuerySourceForAgent('mercury-crew', true).startsWith('agent:'), getQuerySourceForAgent('mercury-crew', true))
  check('a custom crewmate is an agent source', getQuerySourceForAgent('reviewer', false).startsWith('agent:'), getQuerySourceForAgent('reviewer', false))
  const compact = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  const restamps = [...compact.matchAll(/^.*reAppendSessionMetadata\(\).*$/gm)].map(m => m[0].trim())
  check('every session-metadata restamp in the fold is guarded on the main conversation (no agent id)', restamps.length > 0 && restamps.every(line => line.includes('context.agentId === undefined')), restamps.join(' | '))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
