#!/usr/bin/env bun
// ============================================================================
//  prove-skill-tool-failure-reason — the Skill tool says which embedded
//  command failed and why, and an interrupt reads as an interrupt
//  (release-hardening audit rank 64).
//
//  The gap: an inline expansion whose embedded shell block exited non-zero,
//  was denied by a permission rule, or was interrupted — or any other throw
//  inside the prompt expansion — surfaced as "Error calling tool Skill:
//  Command processing failed". The specific sentence naming the embedded
//  command and its stderr was already produced upstream and carried in the
//  processor's returned messages; the tool discarded it, so the model could
//  neither fix nor route around the failure and re-invoked the same skill
//  until the repetition guard refused it. An interrupt mid-apply read as the
//  same generic failure.
//
//    L1 a failure carries the processor's own sentence, naming the skill
//    L2 an interrupt throws an AbortError naming the interruption
//    L3 a typed refusal (resultText) rides along
//    L4 nothing to say still names the skill; the loading echo row is
//       never mistaken for a reason
//    L5 the tool throws through the one composer (source pin)
//
//  PROVE_SRC names another checkout's src (the A/B control: red at the
//  pre-fix tree — no composer).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = join(process.env.TMPDIR ?? '/tmp', `skill-failure-${process.pid}`)
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const skillTool = await import(join(SRC, 'tools/SkillTool/SkillTool.ts'))
const { INTERRUPT_MESSAGE } = await import(join(SRC, 'utils/messages/rejectionText.ts'))
const compose = skillTool.refusedExpansionError as ((name: string, processed: unknown) => Error) | undefined
check('the composer is exported', typeof compose === 'function')

const user = (content: string): unknown => ({ type: 'user', message: { content } })
const echo = user('<command-name>/deploy</command-name>\n<command-args>prod</command-args>')
const stderr = '<local-command-stderr>Error: Bash command failed: `./scripts/deploy.sh prod` exited 2 — permission denied: deploy.lock</local-command-stderr>'

console.log('L1 a failure carries the processor\'s own sentence')
{
  const error = compose?.('deploy', { messages: [echo, user(stderr)], shouldQuery: false })
  check('the error names the skill', error?.message.startsWith('Skill /deploy failed:') === true, error?.message)
  check('and carries the embedded command and its stderr verbatim', error?.message.includes('./scripts/deploy.sh prod') === true && error?.message.includes('permission denied: deploy.lock') === true, error?.message)
  check('it is not an interrupt', error?.name !== 'AbortError')
}

console.log('L2 an interrupt is an interrupt')
{
  const error = compose?.('deploy', { messages: [echo, user(INTERRUPT_MESSAGE as string)], shouldQuery: false })
  check('the error is an AbortError', error?.name === 'AbortError', error?.name)
  check('and says the skill was interrupted', /interrupted/i.test(error?.message ?? '') && error?.message.includes('/deploy') === true, error?.message)
}

console.log('L3 a typed refusal rides along')
{
  const error = compose?.('deploy', { messages: [echo], shouldQuery: false, resultText: '/deploy is interactive-only — run it from the chat.' })
  check('the refusal text is the reason', error?.message.includes('interactive-only') === true, error?.message)
}

console.log('L4 nothing to say still names the skill')
{
  const error = compose?.('deploy', { messages: [echo], shouldQuery: false })
  check('the loading echo is never the reason', error?.message.includes('<command-name>') === false, error?.message)
  check('the skill is named and the emptiness is stated', error?.message.includes('/deploy') === true && /no reason/i.test(error?.message ?? ''), error?.message)
}

console.log('L5 the tool throws through the composer (source pin)')
{
  const src = readFileSync(join(SRC, 'tools/SkillTool/SkillTool.ts'), 'utf8')
  check('the inline road throws refusedExpansionError(name, processed)', src.includes('throw refusedExpansionError(name, processed)'))
  check('the generic sentence is gone', !src.includes("throw new Error('Command processing failed')"))
}

console.log(failures === 0 ? '\nprove-skill-tool-failure-reason: ALL PASS' : `\nprove-skill-tool-failure-reason: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
