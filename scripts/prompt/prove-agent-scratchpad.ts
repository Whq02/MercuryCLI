#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-scratchpad-temp-')))
process.env.MERCURY_TMPDIR = tempRoot
delete process.env.MERCURY_CONCOURSE_WORKER

const { getScratchpadDir, getMercuryTempDir } = await import('../../src/utils/permissions/filesystem.ts')
const { getOriginalCwd, getSessionId } = await import('../../src/bootstrap/state.ts')
const scratchpad = await import('../../src/utils/scratchpad.ts')
const prompts = await import('../../src/constants/prompts.ts')
const { injectTurnReceipts } = await import('../../src/utils/cockpit/turnReceipt.ts')

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
  (await prompts.enhanceSystemPromptWithEnvDetails([`Agent ${agentId} instructions.`], MODEL, undefined, undefined, agentId)).join('\n\n')

section('§1 a session without sub-agents: the root, in the words it always had')
const root = getScratchpadDir()
const rootLine = `Scratchpad directory: ${root} — this session's own place ${purpose}`
const main = await prompts.computeSimpleEnvInfo(MODEL)
const sub = await prompts.computeEnvInfo(MODEL)
check('the root is the project temp + session id + scratchpad, as the daemon derives it', root === scratchpad.scratchpadDirFor(getOriginalCwd(), getSessionId()) && root.endsWith(`${getSessionId()}/scratchpad`), root)
check('the main environment block carries the root line, byte for byte', main.includes(` - ${rootLine}`), scratchpadLine(main))
check('an environment block built without an agent id carries the same line, byte for byte', sub.includes(`\n${rootLine}\n`), scratchpadLine(sub))

section('§2 two sub-agents of one session: each its own folder under the root, each announced in its own environment section')
const first = 'a1stagent'
const second = 'a2ndagent'
const envA = await agentEnv(first)
const envB = await agentEnv(second)
const dirA = announced(envA)
const dirB = announced(envB)
check('the first agent is told its own folder under the root', dirA === join(root, first), `told ${dirA}`)
check('the second agent is told its own folder under the root', dirB === join(root, second), `told ${dirB}`)
check('the two agents are told two different folders', dirA !== '' && dirA !== dirB, `both told ${dirA}`)
check("each agent's line is inside its own <env> block", /<env>[\s\S]*Scratchpad directory: [\s\S]*<\/env>/.test(envA) && /<env>[\s\S]*Scratchpad directory: [\s\S]*<\/env>/.test(envB))
check('composing the prompt creates each folder, so the first write there lands', existsSync(join(root, first)) && existsSync(join(root, second)))
check("the agent's line says whose place it is and what it is for", scratchpadLine(envA) === `Scratchpad directory: ${join(root, first)} — this agent's own place ${purpose}`, scratchpadLine(envA))
check('the parent session keeps the root, before and after the launches', announced(await prompts.computeSimpleEnvInfo(MODEL)) === root && (await prompts.computeSimpleEnvInfo(MODEL)) === main)
writeFileSync(join(dirA, 'helper.mjs'), 'export const lane = 1\n')
writeFileSync(join(dirB, 'helper.mjs'), 'export const lane = 2\n')
check("the first agent's helper survives the second agent's write of the same name", readFileSync(join(dirA, 'helper.mjs'), 'utf8') === 'export const lane = 1\n', `the first agent's helper now reads: ${readFileSync(join(dirA, 'helper.mjs'), 'utf8').trim()}`)

section('§3 a resumed agent keeps its folder')
const envAgain = await agentEnv(first)
check('the same id is told the same folder', announced(envAgain) === join(root, first) && announced(envAgain) === dirA, `told ${announced(envAgain)}`)
check('…with its files still there', existsSync(join(root, first, 'helper.mjs')) && readFileSync(join(root, first, 'helper.mjs'), 'utf8') === 'export const lane = 1\n')

section('§4 the launch hands the id to the prompt build, after the id is minted')
const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
const runAgent = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
const mintAt = agentTool.indexOf("const earlyAgentId = generateTaskId('local_agent')")
const buildAt = agentTool.search(/buildDefaultSystemPrompt\(\s*agentDef,\s*context,\s*plan\.model,\s*earlyAgentId,?\s*\)/)
check('the tool-side build names the minted id', buildAt > 0)
check('…and runs after the mint, the worktree preflight still before it', mintAt > 0 && buildAt > mintAt && agentTool.indexOf('preflightWorktreeCapability(') < mintAt)
check("the run loop's own build names the id the run carries (a resume passes its own)", /buildAgentSystemPrompt\(\s*agentDefinition,\s*toolUseContext,\s*resolvedAgentModel,\s*enabledToolNames,\s*agentId,?\s*\)/.test(runAgent) && runAgent.includes("const agentId = (override?.agentId ?? generateTaskId('local_agent')) as AgentId"))

section("§5 a forked sub-agent keeps the parent's prompt bytes and is told its own folder under the root on a new row")
const fork = await import('../../src/tools/AgentTool/forkSubagent.ts') as Record<string, unknown>
const forkling = 'aforkling'
const RED_FORK = 'RED WHERE THE FORK KEEPS THE PARENT\'S SCRATCHPAD LINE'
const buildScratchpadNotice = fork.buildScratchpadNotice as ((dir: string) => string) | undefined
check(`${RED_FORK}: the fork road owns a scratchpad notice beside its worktree notice`, typeof buildScratchpadNotice === 'function' && typeof fork.buildWorktreeNotice === 'function')
const forkDir = scratchpad.ensureScratchpadDir(forkling)
const notice = buildScratchpadNotice?.(forkDir) ?? ''
check(`${RED_FORK}: the notice carries the agent's own line for the folder under the root, in the one owner's words`, forkDir === join(root, forkling) && notice.includes(`Scratchpad directory: ${forkDir} — this agent's own place ${purpose}`), notice)
check("the notice says the inherited environment section's scratchpad is the parent's", /inherited/.test(notice) && /parent/.test(notice), notice)
check('the folder exists once the notice is built', existsSync(forkDir))
const forkArm = agentTool.slice(mintAt, agentTool.indexOf('// 16. Worktree creation'))
check(`${RED_FORK}: after the mint, the fork arm appends the notice for the minted id to its prompt rows`, mintAt > 0 && /if \(isFork\) \{[\s\S]*?buildScratchpadNotice\(ensureScratchpadDir\(earlyAgentId\)\)[\s\S]*?\}/.test(forkArm), forkArm.trim().split('\n').slice(0, 12).join('\n'))
check("the fork's prompt bytes stay the parent's: the rendered prompt is inherited unchanged and the default build still skips the fork", agentTool.includes('systemPromptOverride = [...rendered]') && agentTool.includes('if (!isFork && !willOverrideCwd) {'))

section("§6 the session's sweep takes the agents' folders; the receipt counts an edit there as a scratchpad edit")
const rows = injectTurnReceipts(
  [
    { type: 'user', uuid: 'p1', message: { role: 'user', content: 'build the thing' } },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { filePath: join(root, first, 'notes.md'), structuredPatch: [{ lines: ['+one'] }] } },
  ] as never,
  getMercuryTempDir(),
) as Array<{ type: string; counts?: { scratchpadEdits: number; fileEdits: number } }>
const receipt = rows.find(r => r.type === 'turn_receipt')
check("an edit under an agent's folder is a scratchpad edit, not a file edit", receipt?.counts?.scratchpadEdits === 1 && receipt?.counts?.fileEdits === 0, JSON.stringify(receipt?.counts))
writeFileSync(join(root, 'parent.txt'), 'x\n')
const swept = scratchpad.sweepOwnScratchpad()
check("the session's sweep takes the root, both agents' folders and the fork's", swept.swept === true && !existsSync(root) && !existsSync(join(root, first)) && !existsSync(join(root, second)) && !existsSync(forkDir))

rmSync(tempRoot, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
