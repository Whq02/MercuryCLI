#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-prune-protections.ts — the NAMED pruning-protection
//  law (spec 07-C1): protected classes never blanked, the placeholder-cost
//  floor honoured, one module owning the predicate, every pruning path
//  importing it.
//
//    §A the predicate — skill results, skill-file reads (path-marked),
//       plan/brief references protected; ordinary reads/searches not
//    §B the floor — a small result is never blanked (net-loss law)
//    §C the clearing path — a protected tool_use never joins the candidate
//       list even when the allow-list would take it; a small result
//       survives the clearing pass verbatim
//    §D the consumers (structural) — both pruning paths import THIS module
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-prune-protections.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

const ROOT = join(import.meta.dir, '..', '..')
// Arm the time-based trigger through its registered env flag (read live);
// the defaults then govern: 60-minute gap, keep the 5 most recent.
process.env.MERCURY_TIME_BASED_MC = '1'
const law = await import('../../src/services/compact/pruneProtections.ts')
const { projectTimeBasedMicrocompact } = await import('../../src/services/compact/microCompact.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message

// ============================================================================
section('§A the predicate')
// ============================================================================
{
  check('Skill results are protected', law.isProtectedFromPruning('Skill'))
  check('Brief results are protected', law.isProtectedFromPruning('Brief'))
  check('plan-mode references are protected', law.isProtectedFromPruning('ExitPlanMode') && law.isProtectedFromPruning('EnterPlanMode'))
  check('a skill-file Read is protected by its path', law.isProtectedFromPruning('Read', { file_path: '/repo/mercury-skills/deploy/SKILL.md' }) && law.isProtectedFromPruning('Read', { file_path: '/Users/x/.mercury/skills/review/SKILL.md' }))
  // FN-015 rank 60: every skill directory Mercury builds comes from node's
  // join — backslashes on win32 — and the model's raw tool input keeps that
  // spelling, so a substring test against POSIX marks protected NOTHING on
  // Windows: the skill's reference material was blanked mid-session there
  // while the same read on macOS/Linux stayed. Separators and case fold
  // before the marks are tested.
  check(
    'a skill-file Read spelled with Windows separators is protected',
    law.isProtectedFromPruning('Read', { file_path: 'C:\\Users\\x\\.mercury\\skills\\review\\SKILL.md' }) &&
      law.isProtectedFromPruning('FileRead', { file_path: 'C:\\repo\\mercury-skills\\deploy\\SKILL.md' }),
  )
  check(
    'a skill-file Read spelled in another case is protected (win32 folds case)',
    law.isProtectedFromPruning('Read', { file_path: 'C:\\Repo\\Mercury-Skills\\deploy\\SKILL.md' }) &&
      law.isProtectedFromPruning('Read', { file_path: 'C:\\Users\\x\\.mercury\\Skills\\review\\SKILL.md' }),
  )
  check('an ordinary Windows-spelled Read is NOT protected', !law.isProtectedFromPruning('Read', { file_path: 'C:\\repo\\src\\index.ts' }))
  check('an ordinary Read is NOT protected', !law.isProtectedFromPruning('Read', { file_path: '/repo/src/index.ts' }))
  check('Bash/Grep results are NOT protected', !law.isProtectedFromPruning('Bash') && !law.isProtectedFromPruning('Grep'))
  check('an unnamed tool is not protected (no invented protection)', !law.isProtectedFromPruning(undefined))
}

// ============================================================================
section('§B the floor')
// ============================================================================
{
  check('at/below the floor: never blank', law.isBelowPlaceholderFloor(law.PLACEHOLDER_COST_FLOOR_TOKENS) && law.isBelowPlaceholderFloor(1))
  check('above the floor: blanking may pay', !law.isBelowPlaceholderFloor(law.PLACEHOLDER_COST_FLOOR_TOKENS + 1))
}

// ============================================================================
section('§C the clearing path honours both laws')
// ============================================================================
{
  const OLD = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
  const stamp = (m: Message): Message => ({ ...m, timestamp: OLD }) as Message
  const big = 'x'.repeat(4000)
  // SEVEN compactable candidates (protected uses never join): the default
  // keep-recent window (5) leaves the FIRST TWO — bash_big and bash_small —
  // as the clearing set; the floor then spares bash_small.
  const fillers = ['f1', 'f2', 'f3', 'f4', 'bash_recent']
  const history: Message[] = [
    stamp(createUserMessage({ content: 'go' }) as Message),
    stamp(createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'skill_1', name: 'Skill', input: { skill: 'deploy' } },
        { type: 'tool_use', id: 'read_skill', name: 'Read', input: { file_path: '/x/mercury-skills/a/SKILL.md' } },
        { type: 'tool_use', id: 'bash_big', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'bash_small', name: 'Bash', input: { command: 'pwd' } },
        ...fillers.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: id } })),
      ] as never,
    }) as Message),
    stamp(createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'skill_1', content: big },
        { type: 'tool_result', tool_use_id: 'read_skill', content: big },
        { type: 'tool_result', tool_use_id: 'bash_big', content: big },
        { type: 'tool_result', tool_use_id: 'bash_small', content: 'tiny' },
        ...fillers.map(id => ({ type: 'tool_result', tool_use_id: id, content: big })),
      ] as never,
    }) as Message),
    stamp(createAssistantMessage({ content: [{ type: 'text', text: 'done', citations: null }] as never }) as Message),
  ]
  const projected = projectTimeBasedMicrocompact(history, 'repl_main_thread_prompt')
  if (projected === null) {
    check('the clearing pass armed for the fixture', false, 'projection returned null with MERCURY_TIME_BASED_MC=1')
  } else {
    const text = JSON.stringify(projected.messages)
    check('the protected Skill result survives verbatim', text.includes(big.slice(0, 100)) && text.includes('skill_1'))
    const resultOf = (id: string): string => {
      for (const m of projected.messages) {
        const content = (m as { message?: { content?: unknown } }).message?.content
        if (!Array.isArray(content)) continue
        const hit = (content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>).find(b => b.type === 'tool_result' && b.tool_use_id === id)
        if (hit) return JSON.stringify(hit.content)
      }
      return ''
    }
    check('Skill + skill-file reads keep their bytes', resultOf('skill_1').includes('xxxx') && resultOf('read_skill').includes('xxxx'))
    check('the BIG ordinary Bash result cleared to a digest', !resultOf('bash_big').includes('xxxx') && resultOf('bash_big').length > 2)
    check('the SMALL result stays (placeholder floor)', resultOf('bash_small').includes('tiny'))
    check('the most recent compactable result stays (keep-recent)', resultOf('bash_recent').includes('xxxx'))
  }
}

// ============================================================================
section('§D the consumers (structural)')
// ============================================================================
{
  const micro = readFileSync(join(ROOT, 'src/services/compact/microCompact.ts'), 'utf8')
  check('the clearing path imports the law', micro.includes("from './pruneProtections.js'") && micro.includes('isProtectedFromPruning(') && micro.includes('isBelowPlaceholderFloor('))
  const plan = readFileSync(join(ROOT, 'src/services/run/requestContextPlan.ts'), 'utf8')
  check('the budget path unions the protected names into its skip set', plan.includes('PROTECTED_TOOL_NAMES'))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
