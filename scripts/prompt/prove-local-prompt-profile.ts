#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { answeredWith, frameLines, lastOutcome } from '../lib/rows.ts'
import {
  captureRoad,
  commitChange,
  dist,
  LOCAL_FIXTURE_MODEL,
  reminderTextsOf,
  scratchHome,
  seedProject,
  systemTextOf,
  tokenizedCount,
  tokenizedTokens,
  toolNamesOf,
  userContextReminderOf,
  type ChatFunction,
  type ChatRequest,
  type ScriptedReply,
} from './_localProfileCapture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_PROMPT_PROFILE
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'local-profile-proof-home-'))

const { localLaw, LOCAL_SUBAGENT_DOCTRINE, LOCAL_POSTURE_WORDS, localToolForm } = await import('../../src/constants/localPromptProfile.ts')
const { MERCURY_CONSTITUTION, MERCURY_HEADLESS_CONSTITUTION } = await import('../../src/prompt/mercuryContract.ts')

const CEILINGS = { system: 5_600, tools: 5_700, tokens: 4_700 } as const
const CORE = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'ToolSearch']
const ANNOUNCED = ['AstSearch', 'ChangeSet', 'Crewmate', 'Eval', 'LspRead', 'Skill', 'Test']
const FIXTURE = join(import.meta.dir, 'fixtures', 'local-profile', 'cloud-zai-system.txt')
const USER_CONTEXT_FIXTURE = join(import.meta.dir, 'fixtures', 'local-profile', 'cloud-zai-user-context.txt')
const ONE_CALL = '- Make one tool call per message, then act on its result.'
const BATCH = '- Calls in one message run in order:'
const tokenizerArg = process.argv.indexOf('--tokenizer')
const tokenizer = tokenizerArg >= 0 ? process.argv[tokenizerArg + 1] : undefined
const recording = process.argv.includes('--record')
const LOCAL_MODEL = `local/${LOCAL_FIXTURE_MODEL}`

let failures = 0
let checks = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const isCrewmateRequest = (request: ChatRequest): boolean => systemTextOf(request).includes('<subagent-doctrine>')
const firstLine = (text: string): string => text.split('\n')[0]!
const textOf = (request: ChatRequest): string => JSON.stringify(request.messages)
const MOVED = ['# Lineage', '# Scratchpad', '# gitStatus']
const VOLATILE_IN_SYSTEM = ['# Lineage', 'Scratchpad directory:', 'gitStatus:']

check('the built product is present', existsSync(dist), dist)
if (!existsSync(dist)) process.exit(1)

function mainScript(): (request: ChatRequest) => ScriptedReply {
  let mainSteps = 0
  return request => {
    if (isCrewmateRequest(request)) return { kind: 'text', text: 'CREW-DONE' }
    mainSteps++
    if (mainSteps === 1) return { kind: 'tool_calls', calls: [{ name: 'ToolSearch', args: { query: 'select:Crewmate' } }] }
    if (mainSteps === 2) return { kind: 'tool_calls', calls: [{ name: 'Crewmate', args: { description: 'fixture crewmate', prompt: 'Reply with the single word CREW-DONE.' } }] }
    return { kind: 'text', text: 'MAIN-DONE' }
  }
}

const strip = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(strip)
  if (typeof schema !== 'object' || schema === null) return schema
  return Object.fromEntries(Object.entries(schema as Record<string, unknown>).filter(([key]) => key !== 'description' && key !== '$schema').map(([key, value]) => [key, strip(value)]))
}

function contractHolds(local: ChatFunction, full: ChatFunction): string | null {
  const localParams = local.parameters as { properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown; type?: unknown }
  const fullParams = full.parameters as typeof localParams
  if (JSON.stringify(localParams.required) !== JSON.stringify(fullParams.required)) return `required ${JSON.stringify(localParams.required)} vs ${JSON.stringify(fullParams.required)}`
  if (localParams.additionalProperties !== fullParams.additionalProperties || localParams.type !== fullParams.type) return 'the schema frame moved'
  for (const [name, property] of Object.entries(localParams.properties ?? {})) {
    const original = fullParams.properties?.[name]
    if (original === undefined) return `${name} is not a parameter of the full tool`
    if (JSON.stringify(strip(property)) !== JSON.stringify(strip(original))) return `${name}: ${JSON.stringify(strip(property))} vs ${JSON.stringify(strip(original))}`
  }
  return null
}

section('§1 the local wire — mercury run on a TensorFold fixture: the profile\'s system prompt and core tools')
const local = await captureRoad({ road: 'local', task: 'Delegate one fixture task to a crewmate.', reply: mainScript(), maxTurns: 4, mode: 'flow' })
const outcome = lastOutcome(frameLines(local.stdout))
check('the run completes on the local road with the main answer', local.code === 0 && answeredWith(local.stdout, 'MAIN-DONE'), `${JSON.stringify(outcome ?? null).slice(0, 300)} ${local.stderr.slice(-300)}`)
const mainRequests = local.requests.filter(request => !isCrewmateRequest(request))
const crewRequests = local.requests.filter(isCrewmateRequest)
check('three main requests and one crewmate request rode the wire', mainRequests.length === 3 && crewRequests.length === 1, `${mainRequests.length} main, ${crewRequests.length} crewmate`)
const first = mainRequests[0]
const head = `Working directory: ${local.cwd}\n\n`
const system = first ? systemTextOf(first) : ''
const toolBytes = first ? bytes(JSON.stringify(first.tools ?? [])) : 0
const systemBytes = bytes(local.normalize(system))
const reminderBytes = first ? reminderTextsOf(first).reduce((total, text) => total + bytes(local.normalize(text)), 0) : 0
console.log(`  [INFO] system ${systemBytes} B · tools ${toolBytes} B in ${first?.tools?.length ?? 0} definitions · reminders ${reminderBytes} B · estimate ${Math.round((systemBytes + toolBytes) / 3.9)} tokens for system and tools (bytes/3.9)`)
check('RED ON A TREE WITHOUT THE PROFILE: the local system prompt is the profile — the head, then the local law', system.startsWith(head + localLaw(LOCAL_MODEL)), JSON.stringify(system.slice(0, 160)))
check('the law keeps the loop reminder first and explains the reminder blocks (FACTS P18, P27, Q17, L7, Q18)', system.includes('- You work in a loop: call a tool, read its result, call the next, until the task is done.') && system.includes('- Blocks wrapped in <system-reminder> tags are notes from the harness'))
check('on TensorFold the law keeps the batching sentence (FACTS T11)', system.includes(BATCH) && !system.includes(ONE_CALL))
check('RED ON A TREE WITHOUT THE PROFILE: the local prompt is not the cloud composition (neither constitution rides)', !system.includes(firstLine(MERCURY_HEADLESS_CONSTITUTION)) && !system.includes(firstLine(MERCURY_CONSTITUTION)))
check('the cloud-only sections are gone (model currency, the harness map)', !system.includes('Model currency:') && !system.includes('# Mercury harness map'))
check('the unattended posture rides in the profile\'s words and names how to load AskUserQuestion', system.includes(LOCAL_POSTURE_WORDS.unattended) && LOCAL_POSTURE_WORDS.unattended.includes('select:AskUserQuestion'))
check(`the local system prompt stays under its ceiling (${CEILINGS.system} B)`, systemBytes <= CEILINGS.system, `${systemBytes} B`)
check(`the local tool array stays under its ceiling (${CEILINGS.tools} B)`, toolBytes > 0 && toolBytes <= CEILINGS.tools, `${toolBytes} B`)
check('the tools term is the core seven in pool order', first !== undefined && toolNamesOf(first).join(',') === CORE.join(','), first ? toolNamesOf(first).join(',') : 'no request')
check('each core tool rides in the profile\'s short form', first !== undefined && (first.tools ?? []).every(tool => tool.function.description === localToolForm(tool.function.name, LOCAL_MODEL, '', {}).description))
const roster = first ? reminderTextsOf(first).find(text => text.includes('Deferred tools:')) ?? '' : ''
const rosterLines = roster.split('\n').filter(line => line !== '' && !line.startsWith('<') && !line.startsWith('Deferred tools:'))
const withPurpose = rosterLines.filter(line => line.includes(' — ')).map(line => line.split(' — ')[0]!)
check(`exactly ${ANNOUNCED.join(', ')} are announced with their purpose; Crewmate, Skill and Eval ride there, never defined`, withPurpose.join(',') === ANNOUNCED.join(',') && ['Crewmate', 'Skill', 'Eval'].every(name => !toolNamesOf(first!).includes(name)), `with purpose: ${withPurpose.join(', ')}`)
check('every other roster line is a bare name', rosterLines.filter(line => !line.includes(' — ')).every(line => /^[\w-]+$/.test(line)), rosterLines.filter(line => !line.includes(' — ') && !/^[\w-]+$/.test(line)).join(' | '))
if (tokenizer !== undefined && first !== undefined) {
  const tokens = await tokenizedCount(tokenizer, { model: LOCAL_FIXTURE_MODEL, messages: first.messages, tools: first.tools })
  console.log(`  [INFO] the first request on the engine's tokenizer: ${tokens ?? 'unavailable'} tokens`)
  check(`the first local request stays under its token ceiling on the engine's tokenizer (${CEILINGS.tokens})`, tokens !== undefined && tokens <= CEILINGS.tokens, String(tokens))
}

section('§2 the per-session text leaves the system message on the local route (REVIEW C3; FACTS Q20, Q22, T6, T1)')
check('RED ON A TREE WITHOUT THE MOVE: the system text carries no lineage, scratchpad line or git status', VOLATILE_IN_SYSTEM.every(marker => !system.includes(marker)), VOLATILE_IN_SYSTEM.filter(marker => system.includes(marker)).join(', '))
check('the static git rules stay in the system text', system.includes('gitRules: '))
const opening = first ? userContextReminderOf(first) : ''
check('the first user turn\'s reminder carries the lineage, the scratchpad line and the git status beside the date', MOVED.every(marker => opening.includes(marker)) && opening.includes('# currentDate'), opening.slice(0, 300))
check('the reminder rides once: every later request carries the same single copy (never repeated)', mainRequests.every(request => (textOf(request).match(/# gitStatus/g) ?? []).length === 1))

section('§3 the tool contract — the short forms keep every name, type and required field of the full tools')
const cloud = await captureRoad({ road: 'zai', task: 'Read README.md and state its first heading.', reply: () => ({ kind: 'text', text: 'FIRST-CALL-DONE' }), maxTurns: 2 })
const cloudFirst = cloud.requests[0]
check('the cloud fixture turn completes on the ZAI road', cloud.code === 0 && answeredWith(cloud.stdout, 'FIRST-CALL-DONE'), cloud.stderr.slice(-300))
for (const name of CORE) {
  const short = first?.tools?.find(tool => tool.function.name === name)?.function
  const full = cloudFirst?.tools?.find(tool => tool.function.name === name)?.function
  const verdict = short !== undefined && full !== undefined ? contractHolds(short, full) : 'missing on a road'
  check(`${name}: every advertised parameter is the full tool's, type for type; required and the schema frame unchanged`, verdict === null, verdict ?? '')
}

section('§4 the prefix holds between steps — each request begins with the one before it, byte for byte')
for (let i = 1; i < mainRequests.length; i++) {
  const before = mainRequests[i - 1]!
  const after = mainRequests[i]!
  const sameTools = JSON.stringify(before.tools) === JSON.stringify(after.tools)
  const prefix = before.messages.every((message, index) => JSON.stringify(message) === JSON.stringify(after.messages[index]))
  check(`main step ${i + 1}: the tools term and the first ${before.messages.length} messages of step ${i} are unchanged`, sameTools && prefix, sameTools ? 'a message moved' : 'the tools term moved')
}
check('no system row rides after position 0 on any request', local.requests.every(request => request.messages.slice(1).every(message => message.role !== 'system')))

section('§5 a crewmate on the local model receives the profile, its per-session text in its first user turn')
const crew = crewRequests[0]
const crewSystem = crew ? systemTextOf(crew) : ''
check('RED ON A TREE WITHOUT THE PROFILE: the crewmate\'s system prompt carries the local law and the local doctrine', crewSystem.includes(localLaw(LOCAL_MODEL)) && crewSystem.includes(LOCAL_SUBAGENT_DOCTRINE), JSON.stringify(crewSystem.slice(0, 200)))
check('the crewmate\'s prompt carries neither the cloud constitution nor the model-currency note', !crewSystem.includes(MERCURY_CONSTITUTION) && !crewSystem.includes('Model currency:'))
check('the crewmate\'s tools defer the same set (no Crewmate, Skill or Eval definition)', crew !== undefined && ['Crewmate', 'Skill', 'Eval'].every(name => !toolNamesOf(crew).includes(name)), crew ? toolNamesOf(crew).join(',') : 'no crewmate request')
const crewOpening = crew ? userContextReminderOf(crew) : ''
check('the crewmate\'s scratchpad line and git status ride its first user turn, not its system text', !crewSystem.includes('Scratchpad directory:') && !crewSystem.includes('gitStatus:') && crewOpening.includes('# Scratchpad') && crewOpening.includes('# gitStatus'), crewOpening.slice(0, 200))
console.log(`  [INFO] crewmate system ${bytes(local.normalize(crewSystem))} B · tools ${crew ? bytes(JSON.stringify(crew.tools ?? [])) : 0} B`)

section('§6 cloud models unchanged — the composition and the first-turn reminder are the recorded ones, and the profile is inert')
const cloudSystem = cloudFirst ? cloud.normalize(systemTextOf(cloudFirst)) : ''
const cloudUserContext = cloudFirst ? cloud.normalize(userContextReminderOf(cloudFirst)) : ''
if (recording) {
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, cloudSystem)
  writeFileSync(USER_CONTEXT_FIXTURE, cloudUserContext)
  console.log(`  [INFO] recorded ${FIXTURE} (${bytes(cloudSystem)} B) and ${USER_CONTEXT_FIXTURE} (${bytes(cloudUserContext)} B) from ${dist}`)
}
const recorded = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : ''
const recordedUserContext = existsSync(USER_CONTEXT_FIXTURE) ? readFileSync(USER_CONTEXT_FIXTURE, 'utf8') : ''
check('the cloud system prompt is the recorded composition, byte for byte after the per-run names are normalised (through the turn machine\'s appendSystemContext)', cloudSystem !== '' && cloudSystem === recorded, firstDifference(cloudSystem, recorded))
check('the cloud first-turn reminder is the recorded one, byte for byte (through the attachment orchestrator)', cloudUserContext !== '' && cloudUserContext === recordedUserContext, firstDifference(cloudUserContext, recordedUserContext))
const cloudOff = await captureRoad({ road: 'zai', task: 'Read README.md and state its first heading.', reply: () => ({ kind: 'text', text: 'FIRST-CALL-DONE' }), maxTurns: 2, env: { MERCURY_LOCAL_PROMPT_PROFILE: '0' } })
const offFirst = cloudOff.requests[0]
const shape = (capture: typeof cloud, request: ChatRequest | undefined): string => request === undefined ? '' : capture.normalize(JSON.stringify({ system: systemTextOf(request), tools: request.tools, reminders: reminderTextsOf(request) }))
check('the cloud request with the profile switched off is the same request, byte for byte (system, tools, roster and every reminder)', shape(cloud, cloudFirst) !== '' && shape(cloud, cloudFirst) === shape(cloudOff, offFirst), firstDifference(shape(cloud, cloudFirst), shape(cloudOff, offFirst)))

section('§7 the control arm — MERCURY_LOCAL_PROMPT_PROFILE=0 gives a local model the cloud composition')
const control = await captureRoad({ road: 'local', task: 'Read README.md and state its first heading.', reply: () => ({ kind: 'text', text: 'FIRST-CALL-DONE' }), maxTurns: 2, env: { MERCURY_LOCAL_PROMPT_PROFILE: '0' } })
const controlFirst = control.requests[0]
const controlSystem = controlFirst ? systemTextOf(controlFirst) : ''
check('the switched-off local request carries the headless constitution, the git status in its system text and the full tools', controlSystem.includes(MERCURY_HEADLESS_CONSTITUTION) && controlSystem.includes('gitStatus:') && controlFirst !== undefined && toolNamesOf(controlFirst).includes('Crewmate'), controlFirst ? toolNamesOf(controlFirst).join(',') : 'no request')
console.log(`  [INFO] control arm: system ${bytes(control.normalize(controlSystem))} B · tools ${controlFirst ? bytes(JSON.stringify(controlFirst.tools ?? [])) : 0} B`)

section('§8 off the local route — a rented pod running the TensorFold recipe gets the profile; a vLLM pod keeps today\'s composition')
const podTask = 'Read README.md and state its first heading.'
const podReply = (): ScriptedReply => ({ kind: 'text', text: 'POD-DONE' })
const tfPod = await captureRoad({ road: 'pod', podEngine: 'tensorfold', task: podTask, reply: podReply, maxTurns: 2 })
const tfPodFirst = tfPod.requests[0]
const tfPodSystem = tfPodFirst ? systemTextOf(tfPodFirst) : ''
check('the TensorFold pod turn completes on the compat road', tfPod.code === 0 && answeredWith(tfPod.stdout, 'POD-DONE'), `${tfPod.stderr.slice(-300)}`)
check('RED ON A TREE WITHOUT THE POD ARM: the TensorFold pod is sent the profile — the head, the local law, the core seven in their short forms', tfPodSystem.startsWith(`Working directory: ${tfPod.cwd}\n\n${localLaw(LOCAL_MODEL)}`) && tfPodFirst !== undefined && toolNamesOf(tfPodFirst).join(',') === CORE.join(','), tfPodFirst ? `${JSON.stringify(tfPodSystem.slice(0, 120))} · ${toolNamesOf(tfPodFirst).join(',')}` : 'no request')
const vllmPod = await captureRoad({ road: 'pod', podEngine: 'vllm', task: podTask, reply: podReply, maxTurns: 2 })
const vllmPodOff = await captureRoad({ road: 'pod', podEngine: 'vllm', task: podTask, reply: podReply, maxTurns: 2, env: { MERCURY_LOCAL_PROMPT_PROFILE: '0' } })
const vllmFirst = vllmPod.requests[0]
check('the vLLM pod keeps the cloud composition and the cloud roster (ChangeSet in full, which the profile never loads)', vllmPod.code === 0 && systemTextOf(vllmFirst ?? { model: '', messages: [] }).includes(MERCURY_HEADLESS_CONSTITUTION) && vllmFirst !== undefined && toolNamesOf(vllmFirst).includes('ChangeSet'), vllmFirst ? toolNamesOf(vllmFirst).join(',') : vllmPod.stderr.slice(-300))
check('the vLLM pod request is the same request with the profile switched off, byte for byte', shape(vllmPod, vllmFirst) !== '' && shape(vllmPod, vllmFirst) === shape(vllmPodOff, vllmPodOff.requests[0]), firstDifference(shape(vllmPod, vllmFirst), shape(vllmPodOff, vllmPodOff.requests[0])))

section('§9 two fresh sessions in one project, a commit between them: the system and tools prefix is the same bytes (FACTS T6, T1, Q20)')
const shared = scratchHome('local-profile-sessions')
seedProject(shared.cwd, shared.home, { 'README.md': '# Fixture project\n', 'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js' } }) })
const sessionReply = (): ScriptedReply => ({ kind: 'text', text: 'SESSION-DONE' })
const sessionA = await captureRoad({ road: 'local', task: 'Read README.md and state its first heading.', reply: sessionReply, maxTurns: 2, reuse: shared })
commitChange(shared.cwd, shared.home, 'NOTES.md', 'A change between the two sessions.\n')
const sessionB = await captureRoad({ road: 'local', task: 'Read README.md and state its first heading.', reply: sessionReply, maxTurns: 2, reuse: shared })
const aFirst = sessionA.requests[0]
const bFirst = sessionB.requests[0]
check('both sessions answered', sessionA.code === 0 && sessionB.code === 0 && aFirst !== undefined && bFirst !== undefined, `${sessionA.stderr.slice(-200)} ${sessionB.stderr.slice(-200)}`)
check('the git status differs between the two sessions (the commit is seen)', aFirst !== undefined && bFirst !== undefined && userContextReminderOf(aFirst) !== userContextReminderOf(bFirst))
check('RED ON A TREE WITHOUT THE MOVE: the two sessions send the same system text, byte for byte', aFirst !== undefined && bFirst !== undefined && systemTextOf(aFirst) === systemTextOf(bFirst), aFirst && bFirst ? firstDifference(systemTextOf(aFirst), systemTextOf(bFirst)) : 'missing request')
check('and the same tools term, byte for byte', aFirst !== undefined && bFirst !== undefined && JSON.stringify(aFirst.tools) === JSON.stringify(bFirst.tools))
if (tokenizer !== undefined && aFirst !== undefined && bFirst !== undefined) {
  const systemOf = (request: ChatRequest): ChatRequest['messages'] => request.messages.filter(message => message.role === 'system')
  const prefixA = await tokenizedTokens(tokenizer, { model: LOCAL_FIXTURE_MODEL, messages: [...systemOf(aFirst), { role: 'user', content: 'x' }], tools: aFirst.tools })
  const prefixB = await tokenizedTokens(tokenizer, { model: LOCAL_FIXTURE_MODEL, messages: [...systemOf(bFirst), { role: 'user', content: 'x' }], tools: bFirst.tools })
  const wholeA = await tokenizedTokens(tokenizer, { model: LOCAL_FIXTURE_MODEL, messages: aFirst.messages, tools: aFirst.tools })
  const wholeB = await tokenizedTokens(tokenizer, { model: LOCAL_FIXTURE_MODEL, messages: bFirst.messages, tools: bFirst.tools })
  let common = 0
  while (wholeA !== undefined && wholeB !== undefined && common < wholeA.length && common < wholeB.length && wholeA[common] === wholeB[common]) common++
  const cut = prefixA === undefined ? 0 : prefixA.length - 2
  console.log(`  [INFO] engine tokens: system+tools prefix ${cut}; the two first requests share ${common} of ${wholeA?.length ?? 0} and ${wholeB?.length ?? 0}`)
  check('on the engine\'s tokenizer the two first requests share the whole system+tools prefix (the full cut before the first user text)', prefixA !== undefined && prefixB !== undefined && JSON.stringify(prefixA) === JSON.stringify(prefixB) && common >= cut, `common ${common}, cut ${cut}`)
}

section('§10 llama.cpp — one tool call per message, and admitted tools join the tools term (FACTS L1, L3)')
const llamaReply = (() => {
  let steps = 0
  return (): ScriptedReply => {
    steps++
    if (steps === 1) return { kind: 'tool_calls', calls: [{ name: 'ToolSearch', args: { query: 'select:Crewmate' } }] }
    return { kind: 'text', text: 'LLAMA-DONE' }
  }
})()
const llama = await captureRoad({ road: 'llamacpp', task: 'Load the crewmate tool.', reply: llamaReply, maxTurns: 3 })
const llamaFirst = llama.requests[0]
const llamaSecond = llama.requests[1]
const llamaSystem = llamaFirst ? systemTextOf(llamaFirst) : ''
check('the llama.cpp run answers', llama.code === 0 && answeredWith(llama.stdout, 'LLAMA-DONE'), llama.stderr.slice(-300))
check('RED ON A TREE WITHOUT THE ENGINE GATE: on llama.cpp the law asks for one tool call per message', llamaSystem.includes(ONE_CALL) && !llamaSystem.includes(BATCH), JSON.stringify(llamaSystem.slice(0, 120)))
check('RED ON A TREE WITHOUT THE ENGINE GATE: an admitted tool joins the tools term on llama.cpp, the parser\'s grammar is built from it', llamaSecond !== undefined && toolNamesOf(llamaSecond).includes('Crewmate') && !textOf(llamaSecond).includes('<tools>'), llamaSecond ? toolNamesOf(llamaSecond).join(',') : 'no second request')

section('§11 the first-turn reminder on the attachment road — opening turn only, re-opened after a fold')
{
  const { firstTurnUserContext } = await import('../../src/utils/api.ts')
  const { getUserContextAttachment } = await import('../../src/utils/attachments/userContext.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
  const firstUser = createUserMessage({ content: 'Read README.md.' })
  const userContext = { environment: 'Is a git repository: Yes', currentDate: 'Today\'s date is 2026-01-01.' }
  const systemContext = { gitStatus: 'This is the repository\'s git status: clean', gitRules: 'Git rules.' }
  const merged = await firstTurnUserContext(userContext, systemContext, LOCAL_MODEL, undefined, [firstUser] as never)
  const cloudMerged = await firstTurnUserContext(userContext, systemContext, 'glm-5.3', undefined, [firstUser] as never)
  check('a cloud model gets its own user context object back, untouched', cloudMerged === userContext)
  check('a local model\'s first-turn context carries the scratchpad line and the git status', typeof merged.Scratchpad === 'string' && merged.gitStatus === systemContext.gitStatus && merged.gitRules === undefined)
  const openingRows = await getUserContextAttachment([firstUser] as never, merged, true)
  const openingRow = openingRows[0] as { type?: string; body?: string; context?: Record<string, string> } | undefined
  check('the opening turn delivers the reminder with the moved text', openingRow?.type === 'user_context' && (openingRow.body ?? '').includes('# gitStatus') && (openingRow.body ?? '').includes('# Scratchpad'))
  const attachment = { type: 'attachment', uuid: 'a1', attachment: openingRow } as never
  const later = await getUserContextAttachment([firstUser, attachment, createAssistantMessage({ content: 'ok' })] as never, merged, false)
  check('a later turn repeats nothing (the moved keys are fixed per session)', later.length === 0, JSON.stringify(later).slice(0, 200))
  const folded = [{ type: 'system', subtype: 'compact_boundary', uuid: 'b1', content: 'fold' }, createUserMessage({ content: 'summary of the work so far' })]
  const reopened = await getUserContextAttachment(folded as never, merged, false)
  const reopenedRow = reopened[0] as { body?: string } | undefined
  check('after a fold the next turn re-delivers the moved text', (reopenedRow?.body ?? '').includes('# gitStatus') && (reopenedRow?.body ?? '').includes('# Scratchpad'), JSON.stringify(reopened).slice(0, 200))
}

function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return `differ at char ${at}: ${JSON.stringify(a.slice(Math.max(0, at - 60), at + 80))} vs ${JSON.stringify(b.slice(Math.max(0, at - 60), at + 80))}`
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? '✅ THE LOCAL PROMPT PROFILE HOLDS' : `❌ ${failures} LOCAL PROMPT PROFILE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
