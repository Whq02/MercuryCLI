#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
const scopeHint = ' | fix runPostCompactCleanup in src/engine/compaction/postFoldCleanup.ts (only a main-thread fold with no agentId may clear the memos and section cache)'
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { getGitStatus, getSystemContext, getUserContext } = await import('../../src/engine/requestContext.ts')
const { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } = await import('../../src/boot/process-state/processState.ts')
const { runPostCompactCleanup } = await import('../../src/engine/compaction/postFoldCleanup.ts')

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
  check('the main conversation memoises the git status, the system context, the user context and a prompt section', held() === 'git+system+user' && sectionHeld(), `${held()} · section ${sectionHeld()}` + ' | the priming helpers prime() in this file or the memo caches in src/engine/requestContext.ts did not hold')
  runPostCompactCleanup({ querySource: 'main_thread', agentId: 'aprobe01' })
  check("a crewmate launched by the main thread (its query source is main_thread) folds without clearing the main conversation's memos", held() === 'git+system+user', held() + scopeHint)
  check("…and without clearing the main conversation's system-prompt section cache", sectionHeld(), 'section cache was cleared' + scopeHint)
  runPostCompactCleanup({ querySource: 'sdk', agentId: 'aprobe02' })
  check("a crewmate launched by a headless session (its query source is sdk) folds the same way", held() === 'git+system+user' && sectionHeld(), `${held()} · section ${sectionHeld()}` + scopeHint)
  runPostCompactCleanup({ querySource: 'agent:builtin:mercury-crew', agentId: 'aprobe03' })
  check('a crewmate tagged with its own agent source folds the same way', held() === 'git+system+user' && sectionHeld(), `${held()} · section ${sectionHeld()}` + scopeHint)
}

section('§2 the main conversation\'s own fold still clears what a fold invalidates')
{
  runPostCompactCleanup({ querySource: 'main_thread' })
  check('the main fold (no agent id) clears the three memos', held() === 'none', held() + ' | fix runPostCompactCleanup in src/engine/compaction/postFoldCleanup.ts (a main-thread fold must clear getGitStatus, getSystemContext and getUserContext)')
  check('…and the section cache', !sectionHeld(), 'section cache still held | fix runPostCompactCleanup in src/engine/compaction/postFoldCleanup.ts (clearSystemPromptSections on a main-thread fold)')
  await prime()
  runPostCompactCleanup()
  check('/compact and /clear (no scope at all) clear them the same way', held() === 'none' && !sectionHeld(), `${held()} · section ${sectionHeld()}` + ' | fix runPostCompactCleanup in src/engine/compaction/postFoldCleanup.ts (a call with no scope is a main-thread fold)')
  await prime()
  runPostCompactCleanup('sdk')
  check('the headless main fold (a bare sdk source) clears them too', held() === 'none' && !sectionHeld(), `${held()} · section ${sectionHeld()}` + ' | fix isMainThreadCompaction in src/engine/compaction/postFoldCleanup.ts (a bare sdk source is a main-thread fold)')
}

section('§3 a launched crewmate carries its own query source and never restamps the session metadata')
{
  const { getQuerySourceForAgent } = await import('../../src/tools/crewmate/promptCategory.ts')
  check('a built-in crewmate is an agent source', getQuerySourceForAgent('mercury-crew', true).startsWith('agent:'), getQuerySourceForAgent('mercury-crew', true) + ' | fix getQuerySourceForAgent in src/tools/crewmate/promptCategory.ts')
  check('a custom crewmate is an agent source', getQuerySourceForAgent('reviewer', false).startsWith('agent:'), getQuerySourceForAgent('reviewer', false) + ' | fix getQuerySourceForAgent in src/tools/crewmate/promptCategory.ts')
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
