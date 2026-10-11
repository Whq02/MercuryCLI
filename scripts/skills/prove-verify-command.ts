import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'verify-command-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.NODE_ENV = 'test'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.chdir(scratch)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const { default: command, VERIFIER_BRIEF, verifierPrompt } = await import('../../src/commands/verify.ts')
const { AGENT_TOOL_NAME, MERCURY_CREW_AGENT_TYPE } = await import('../../src/tools/AgentTool/constants.ts')
const { getVerificationNudgeNote } = await import('../../src/tools/TaskUpdateTool/prompt.ts')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
check('the command stays built-in, visible and optionally focused', command.name === 'verify' && command.source === 'builtin' && command.isHidden === false && command.argumentHint === '[focus]')
for (const focus of ['', 'the parser boundary']) {
  const text = (await command.getPromptForCommand(focus)).map(block => block.text).join('\n')
  check('the command gathers the change and original intent before delegation', text.includes('git status --short') && text.includes('git diff') && text.includes('Reconstruct the original intent'))
  check('the launch instruction names the Agent tool and the crew type directly', text.includes(`Launch a crewmate through the ${AGENT_TOOL_NAME} tool with subagent_type \`${MERCURY_CREW_AGENT_TYPE}\``))
  const brief = text.split('## Verification brief for the crewmate\n')[1]
  const work = focus ? `Focus the verification on: ${focus}` : ''
  check('the launch instruction carries the complete brief and the requested work', brief === verifierPrompt(work))
  check('the launch instruction never redirects through a skill', !/\bskill\b/i.test(text))
  check('the caller still spot-checks PASS and relays FAIL or PARTIAL', text.includes('re-run 2-3 commands') && text.includes('On FAIL:') && text.includes('On PARTIAL:') && text.includes('launch another crewmate with the same brief'))
}
check('the brief keeps the break-it charge and the no-project-write law', VERIFIER_BRIEF.startsWith("You are verifying someone else's work for Mercury.") && VERIFIER_BRIEF.includes('## Do not modify the project'))
check('the brief keeps the exact verdict contract', VERIFIER_BRIEF.includes('End your response with exactly one line: `VERDICT: ` then one of `PASS`, `FAIL`, `PARTIAL`'))
const work = 'the task: add a parser; files: src/parse.ts; approach: recursive descent'
check('handed work rides under its own heading', verifierPrompt(work).endsWith(`## The work to verify\n${work}`))
check('an empty brief asks for reconstruction from the work tree', verifierPrompt('').includes('reconstruct the change from the working tree'))
const nudge = getVerificationNudgeNote()
check('the completion nudge names the command, not a skill', nudge.includes('Run /verify to check the work') && !/\bskill\b/i.test(nudge), nudge)
console.log(failures === 0 ? 'VERIFY COMMAND GREEN' : `VERIFY COMMAND RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
