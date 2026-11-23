#!/usr/bin/env bun
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = join(process.env.TMPDIR ?? '/tmp', `skill-failure-${process.pid}`)
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const composerWhere = 'fix refusedExpansionError in src/tools/skill/SkillTool.ts'

const skillTool = await import(join(SRC, 'tools/skill/SkillTool.ts'))
const { INTERRUPT_MESSAGE } = await import(join(SRC, 'engine/message-shapes/rejectionText.ts'))
const compose = skillTool.refusedExpansionError as ((name: string, processed: unknown) => Error) | undefined
check('the composer is exported', typeof compose === 'function', 'export refusedExpansionError from src/tools/skill/SkillTool.ts')

const user = (content: string): unknown => ({ type: 'user', message: { content } })
const echo = user('<command-name>/deploy</command-name>\n<command-args>prod</command-args>')
const stderr = '<local-command-stderr>Error: Bash command failed: `./scripts/deploy.sh prod` exited 2 — permission denied: deploy.lock</local-command-stderr>'

console.log('L1 a failure carries the processor\'s own sentence')
{
  const error = compose?.('deploy', { messages: [echo, user(stderr)], shouldQuery: false })
  check('the error names the skill', error?.message.startsWith('Skill /deploy failed:') === true, `${error?.message} — ${composerWhere} so its message starts with Skill /name failed:`)
  check('and carries the embedded command and its stderr verbatim', error?.message.includes('./scripts/deploy.sh prod') === true && error?.message.includes('permission denied: deploy.lock') === true, `${error?.message} — ${composerWhere} to keep the processed local-command-stderr text in the message`)
  check('it is not an interrupt', error?.name !== 'AbortError', `${composerWhere} to return an AbortError only for INTERRUPT_MESSAGE`)
}

console.log('L2 an interrupt is an interrupt')
{
  const error = compose?.('deploy', { messages: [echo, user(INTERRUPT_MESSAGE as string)], shouldQuery: false })
  check('the error is an AbortError', error?.name === 'AbortError', `${error?.name} — ${composerWhere} to return an AbortError when the processed message is INTERRUPT_MESSAGE`)
  check('and says the skill was interrupted', /interrupted/i.test(error?.message ?? '') && error?.message.includes('/deploy') === true, `${error?.message} — ${composerWhere} so an interrupt message names the skill and says interrupted`)
}

console.log('L3 a typed refusal rides along')
{
  const error = compose?.('deploy', { messages: [echo], shouldQuery: false, resultText: '/deploy is interactive-only — run it from the chat.' })
  check('the refusal text is the reason', error?.message.includes('interactive-only') === true, `${error?.message} — ${composerWhere} to use processed.resultText as the reason when it is set`)
}

console.log('L4 nothing to say still names the skill')
{
  const error = compose?.('deploy', { messages: [echo], shouldQuery: false })
  check('the loading echo is never the reason', error?.message.includes('<command-name>') === false, `${error?.message} — ${composerWhere} so the loading echo message is never used as the reason`)
  check('the skill is named and the emptiness is stated', error?.message.includes('/deploy') === true && /no reason/i.test(error?.message ?? ''), `${error?.message} — ${composerWhere} to name the skill and say no reason was given when the processor said nothing`)
}


console.log(failures === 0 ? '\nprove-skill-tool-failure-reason: ALL PASS' : `\nprove-skill-tool-failure-reason: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
