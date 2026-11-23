#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-scratchpad-temp-')))
process.env.MERCURY_TMPDIR = tempRoot
delete process.env.MERCURY_CONCOURSE_WORKER

const { getScratchpadDir, getMercuryTempDir } = await import('../../src/permissions/rules/filesystem.ts')
const { getOriginalCwd, getSessionId } = await import('../../src/boot/process-state/processState.ts')
const scratchpad = await import('../../src/platform/files/scratchpad.ts')
const prompts = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { injectTurnReceipts } = await import('../../src/screen/cockpit/turnReceipt.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const MODEL = 'claude-opus-5'
const purpose = "for temporary files (helper scripts, intermediate results, captures); use it instead of a system temp directory or the project tree. It lies outside the project, so nothing in it reaches git status, and it is swept when the session ends."
const announced = (block: string): string => (block.match(/^(?:\s*- )?Scratchpad directory: (\S+) — /m) ?? [])[1] ?? ''
const scratchpadLine = (block: string): string => (block.split('\n').find(line => line.includes('Scratchpad directory: ')) ?? '').replace(/^\s*- /, '')
const agentEnv = async (agentId: string): Promise<string> =>
  (await prompts.enhanceSystemPromptWithEnvDetails([`Agent ${agentId} instructions.`], MODEL, undefined, agentId)).join('\n\n')

section('§1 a session without sub-agents: the root, in the words it always had')
const root = getScratchpadDir()
const rootLine = `Scratchpad directory: ${root} — this session's own place ${purpose}`
const main = await prompts.computeSimpleEnvInfo(MODEL)
const sub = await prompts.computeEnvInfo(MODEL)
check('the root is the project temp + session id + scratchpad, as the daemon derives it', root === scratchpad.scratchpadDirFor(getOriginalCwd(), getSessionId()) && root.endsWith(`${getSessionId()}/scratchpad`), `${root}; getScratchpadDir in src/permissions/rules/filesystem.ts must return the path scratchpadDirFor gives`)
check('the main environment block carries the root line, byte for byte', main.includes(` - ${rootLine}`), `${scratchpadLine(main)}; the root line is built by scratchpadPromptLine in src/platform/files/scratchpad.ts`)
check('an environment block built without an agent id carries the same line, byte for byte', sub.includes(`\n${rootLine}\n`), `${scratchpadLine(sub)}; the root line is built by scratchpadPromptLine in src/platform/files/scratchpad.ts`)

section('§2 two sub-agents of one session: each its own folder under the root, each announced in its own environment section')
const first = 'a1stagent'
const second = 'a2ndagent'
const envA = await agentEnv(first)
const envB = await agentEnv(second)
const dirA = announced(envA)
const dirB = announced(envB)
check('the first agent is told its own folder under the root', dirA === join(root, first), `told ${dirA}; the agent environment section in src/engine/system-prompt/defaultSystemPrompt.ts must announce getScratchpadDir(agentId)`)
check('the second agent is told its own folder under the root', dirB === join(root, second), `told ${dirB}; the agent environment section in src/engine/system-prompt/defaultSystemPrompt.ts must announce getScratchpadDir(agentId)`)
check('the two agents are told two different folders', dirA !== '' && dirA !== dirB, `both told ${dirA}; each agent id needs its own folder from getScratchpadDir in src/permissions/rules/filesystem.ts`)
check("each agent's line is inside its own <env> block", /<env>[\s\S]*Scratchpad directory: [\s\S]*<\/env>/.test(envA) && /<env>[\s\S]*Scratchpad directory: [\s\S]*<\/env>/.test(envB), 'the Scratchpad directory line must sit inside the env block of enhanceSystemPromptWithEnvDetails in src/engine/system-prompt/defaultSystemPrompt.ts')
check('composing the prompt creates each folder, so the first write there lands', existsSync(join(root, first)) && existsSync(join(root, second)), 'ensureScratchpadDir in src/platform/files/scratchpad.ts must create the agent folder when the prompt is composed')
check("the agent's line says whose place it is and what it is for", scratchpadLine(envA) === `Scratchpad directory: ${join(root, first)} — this crewmate's own place ${purpose}`, `${scratchpadLine(envA)}; the crewmate wording comes from scratchpadPromptLine in src/platform/files/scratchpad.ts`)
check('the parent session keeps the root, before and after the launches', announced(await prompts.computeSimpleEnvInfo(MODEL)) === root && (await prompts.computeSimpleEnvInfo(MODEL)) === main, 'composing an agent prompt must not change the parent session scratchpad line, see src/engine/system-prompt/defaultSystemPrompt.ts')
writeFileSync(join(dirA, 'helper.mjs'), 'export const lane = 1\n')
writeFileSync(join(dirB, 'helper.mjs'), 'export const lane = 2\n')
check("the first agent's helper survives the second agent's write of the same name", readFileSync(join(dirA, 'helper.mjs'), 'utf8') === 'export const lane = 1\n', `the first agent's helper now reads: ${readFileSync(join(dirA, 'helper.mjs'), 'utf8').trim()}`)

section('§3 a resumed agent keeps its folder')
const envAgain = await agentEnv(first)
check('the same id is told the same folder', announced(envAgain) === join(root, first) && announced(envAgain) === dirA, `told ${announced(envAgain)}; the folder must derive from the agent id alone, see getScratchpadDir in src/permissions/rules/filesystem.ts`)
check('…with its files still there', existsSync(join(root, first, 'helper.mjs')) && readFileSync(join(root, first, 'helper.mjs'), 'utf8') === 'export const lane = 1\n', 'composing the prompt again must not clear or recreate the agent folder, see ensureScratchpadDir in src/platform/files/scratchpad.ts')


section('§5 there is no fork road: no prompt composer or message builder beside the frozen-worktree notice, no fork arm in the tool')
const notice = await import('../../src/tools/crewmate/frozenWorktreeNotice.ts') as Record<string, unknown>
check('frozenWorktreeNotice.ts exports the frozen-worktree notice and nothing else', typeof notice.buildFrozenWorktreeNotice === 'function' && Object.keys(notice).every(k => k === 'buildFrozenWorktreeNotice'), Object.keys(notice).join(','))

section("§6 the session's sweep takes the agents' folders; the receipt counts an edit there as a scratchpad edit")
const rows = injectTurnReceipts(
  [
    { type: 'user', uuid: 'p1', message: { role: 'user', content: 'build the thing' } },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { filePath: join(root, first, 'notes.md'), structuredPatch: [{ lines: ['+one'] }] } },
  ] as never,
  getMercuryTempDir(),
) as Array<{ type: string; counts?: { scratchpadEdits: number; fileEdits: number } }>
const receipt = rows.find(r => r.type === 'turn_receipt')
check("an edit under an agent's folder is a scratchpad edit, not a file edit", receipt?.counts?.scratchpadEdits === 1 && receipt?.counts?.fileEdits === 0, `${JSON.stringify(receipt?.counts)}; isScratchpadPath in src/screen/cockpit/turnReceipt.ts must treat paths under the root as scratchpad edits`)
writeFileSync(join(root, 'parent.txt'), 'x\n')
const swept = scratchpad.sweepOwnScratchpad()
check("the session's sweep takes the root and both agents' folders", swept.swept === true && !existsSync(root) && !existsSync(join(root, first)) && !existsSync(join(root, second)), 'sweepOwnScratchpad in src/platform/files/scratchpad.ts must remove the root with every agent folder under it')

rmSync(tempRoot, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
