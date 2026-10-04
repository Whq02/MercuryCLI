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
  (await prompts.enhanceSystemPromptWithEnvDetails([`Agent ${agentId} instructions.`], MODEL, undefined, agentId)).join('\n\n')

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
const buildAt = agentTool.search(/buildDefaultSystemPrompt\(\s*agentDef,\s*context,\s*plan\.model,\s*earlyAgentId,\s*new Set\(workerTools\.map\(tool => tool\.name\)\),\s*seatOf\(input\),?\s*\)/)
check('the tool-side build names the minted id', buildAt > 0)
check('…and runs after the mint, the worktree preflight still before it', mintAt > 0 && buildAt > mintAt && agentTool.indexOf('preflightWorktreeCapability(') < mintAt)
check("the run loop's own build names the id the run carries (a resume passes its own)", /buildAgentSystemPrompt\(\s*agentDefinition,\s*toolUseContext,\s*resolvedAgentModel,\s*enabledToolNames,\s*agentId,\s*seat,?\s*\)/.test(runAgent) && runAgent.includes("const agentId = (override?.agentId ?? generateTaskId('local_agent')) as AgentId"))

section("§5 a forked sub-agent is told its own folder in its own prompt; every other byte is the parent's")
const fork = await import('../../src/tools/AgentTool/forkSubagent.ts') as Record<string, unknown>
const { splitSysPromptPrefix } = await import('../../src/utils/api.ts')
const { getCLISyspromptPrefix } = await import('../../src/constants/system.ts')
const forkling = 'aforkling'
const RED_FORK = "RED WHERE THE FORK RE-SENDS THE PARENT'S SCRATCHPAD LINE"
const forkSystemPrompt = fork.forkSystemPrompt as ((parent: readonly string[], dir: string) => string[]) | undefined
const compose = forkSystemPrompt ?? ((parent: readonly string[]): string[] => [...parent])
check(`${RED_FORK}: the fork road owns a prompt composer beside its message builder`, typeof forkSystemPrompt === 'function' && typeof fork.buildForkedMessages === 'function')
const forkDir = scratchpad.ensureScratchpadDir(forkling)
const forkLine = `Scratchpad directory: ${forkDir} — this agent's own place ${purpose}`
const wire = (sections: readonly string[]): string => sections.join('\n\n')
const scratchpadLines = (text: string): string[] => text.split('\n').filter(line => line.includes('Scratchpad directory: ')).map(line => line.replace(/^\s*- /, ''))
const sharedBytes = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return Buffer.byteLength(a.slice(0, i))
}
const afterLine = (text: string): string => text.slice(text.indexOf('\n', text.indexOf('Scratchpad directory: ')))
const sectionAt = (sections: readonly string[], offset: number): number => {
  let seen = 0
  for (let i = 0; i < sections.length; i++) {
    seen += sections[i]!.length + 2
    if (offset < seen) return i + 1
  }
  return sections.length
}

const mainParent = await prompts.getSystemPrompt([], MODEL, [])
const mainText = wire(mainParent)
const forkOfMain = compose(mainParent, forkDir)
const forkOfMainText = wire(forkOfMain)
check(`${RED_FORK}: a fork of the main thread is told its own folder, not the session's`, forkDir === join(root, forkling) && announced(forkOfMainText) === forkDir, `told ${announced(forkOfMainText)}`)
check(`${RED_FORK}: its line says whose place it is, in the one owner's words, the bullet kept`, forkOfMainText.includes(`\n - ${forkLine}\n`), scratchpadLine(forkOfMainText))
check(`${RED_FORK}: exactly one scratchpad line, its own — the session's is not re-sent`, scratchpadLines(forkOfMainText).length === 1 && !forkOfMainText.includes(rootLine), scratchpadLines(forkOfMainText).join(' | '))
const lineAt = mainText.indexOf('Scratchpad directory: ')
const lineBytes = Buffer.byteLength(mainText.slice(0, lineAt))
const shared = sharedBytes(mainText, forkOfMainText)
check("every byte before the line is the parent's: the shared prefix reaches the line", lineAt > 0 && shared >= lineBytes && forkOfMainText.slice(0, lineAt) === mainText.slice(0, lineAt), `shared ${shared} bytes, the line starts at byte ${lineBytes}`)
check("every byte after the line is the parent's: the same sections, the same count, the same tail", forkOfMain.length === mainParent.length && afterLine(forkOfMainText) === afterLine(mainText))
const blocks = splitSysPromptPrefix([getCLISyspromptPrefix({ isNonInteractive: false, hasAppendSystemPrompt: false }), ...mainParent])
console.log(`  [NOTE] the main thread's prompt: ${mainParent.length} sections, ${Buffer.byteLength(mainText)} bytes joined; the fork's bytes leave the parent's at byte ${shared} (the scratchpad line starts at byte ${lineBytes}, section ${sectionAt(mainParent, lineAt)} of ${mainParent.length}); on the wire the composed sections travel as ${blocks.length - 1} block after the identity prefix, so the cache keeps the tools and the prefix block and re-reads the rest block and every row after it`)

const parentId = 'aparent01'
const subParent = await prompts.enhanceSystemPromptWithEnvDetails([`Agent ${parentId} instructions.`], MODEL, undefined, parentId)
const forkOfSub = compose(subParent, forkDir)
const forkOfSubText = wire(forkOfSub)
check(`${RED_FORK}: a fork of a sub-agent is told its own folder, not its parent's`, announced(forkOfSubText) === forkDir, `told ${announced(forkOfSubText)}`)
check("…in the parent's slot inside the inherited <env> block, the parent's folder named nowhere", /<env>\n[^]*?\nScratchpad directory: [^\n]*\nPlatform: /.test(forkOfSubText) && scratchpadLines(forkOfSubText).length === 1 && !forkOfSubText.includes(join(root, parentId)), scratchpadLines(forkOfSubText).join(' | '))
check("the shared prefix reaches the line and the tail is the parent's", forkOfSubText.slice(0, forkOfSubText.indexOf('Scratchpad directory: ')) === subParent.join('\n\n').slice(0, subParent.join('\n\n').indexOf('Scratchpad directory: ')) && afterLine(forkOfSubText) === afterLine(subParent.join('\n\n')) && forkOfSub.length === subParent.length)

const bare = ['Mercury — a private terminal software-development harness.\nWorking directory: /somewhere']
const forkOfBare = compose(bare, forkDir)
check(`${RED_FORK}: a parent prompt without a scratchpad line hands the fork its own line as a trailing section`, forkOfBare.length === 2 && forkOfBare[0] === bare[0] && forkOfBare[1] === forkLine, wire(forkOfBare))
check('the folder exists once the prompt is composed', existsSync(forkDir))

const forkArm = agentTool.slice(mintAt, agentTool.indexOf('let worktreeInfo:', mintAt))
check(`${RED_FORK}: after the mint, the fork arm composes its prompt from the parent's bytes for the minted id`, mintAt > 0 && /if \(isFork && systemPromptOverride !== undefined\) \{\s*systemPromptOverride = forkSystemPrompt\(systemPromptOverride, ensureScratchpadDir\(earlyAgentId\)\)\s*\}/.test(forkArm), forkArm.trim().split('\n').slice(0, 12).join('\n'))
check("the notice row that called the inherited environment section the parent's is gone: the prompt is the one carrier", !agentTool.includes('buildScratchpadNotice') && fork.buildScratchpadNotice === undefined)
check("the parent's bytes are still inherited first and the default build still skips the fork", agentTool.includes('systemPromptOverride = [...rendered]') && agentTool.includes('if (!isFork && !willOverrideCwd) {'))
const resumeAgent = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
check(`${RED_FORK}: a fork resume composes the same way, for the resumed id`, /systemPromptOverride = forkSystemPrompt\(systemPromptOverride, ensureScratchpadDir\(agentId\)\)/.test(resumeAgent))

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
