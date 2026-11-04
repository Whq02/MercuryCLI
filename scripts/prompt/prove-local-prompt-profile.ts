#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { answeredWith, frameLines, lastOutcome } from '../lib/rows.ts'
import {
  captureRoad,
  dist,
  LOCAL_FIXTURE_MODEL,
  reminderTextsOf,
  systemTextOf,
  tokenizedCount,
  toolNamesOf,
  type ChatFunction,
  type ChatRequest,
  type ScriptedReply,
} from './_localProfileCapture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_PROMPT_PROFILE

const { LOCAL_LAW, LOCAL_SUBAGENT_DOCTRINE, LOCAL_POSTURE_WORDS, localToolForm } = await import('../../src/constants/localPromptProfile.ts')
const { MERCURY_CONSTITUTION, MERCURY_HEADLESS_CONSTITUTION } = await import('../../src/prompt/mercuryContract.ts')

const CEILINGS = { system: 5_600, tools: 5_700, tokens: 4_700 } as const
const CORE = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'ToolSearch']
const ANNOUNCED = ['AstSearch', 'ChangeSet', 'Crewmate', 'Eval', 'LspRead', 'Skill', 'Test']
const FIXTURE = join(import.meta.dir, 'fixtures', 'local-profile', 'cloud-zai-system.txt')
const tokenizerArg = process.argv.indexOf('--tokenizer')
const tokenizer = tokenizerArg >= 0 ? process.argv[tokenizerArg + 1] : undefined
const recording = process.argv.includes('--record')

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
check('RED ON A TREE WITHOUT THE PROFILE: the local system prompt is the profile — the head, then the local law', system.startsWith(head + LOCAL_LAW), JSON.stringify(system.slice(0, 160)))
check('RED ON A TREE WITHOUT THE PROFILE: the local prompt is not the cloud composition (neither constitution rides)', !system.includes(firstLine(MERCURY_HEADLESS_CONSTITUTION)) && !system.includes(firstLine(MERCURY_CONSTITUTION)))
check('the cloud-only sections are gone (model currency, the harness map)', !system.includes('Model currency:') && !system.includes('# Mercury harness map'))
check('the unattended posture rides in the profile\'s words', system.includes(LOCAL_POSTURE_WORDS.unattended))
check(`the local system prompt stays under its ceiling (${CEILINGS.system} B)`, systemBytes <= CEILINGS.system, `${systemBytes} B`)
check(`the local tool array stays under its ceiling (${CEILINGS.tools} B)`, toolBytes > 0 && toolBytes <= CEILINGS.tools, `${toolBytes} B`)
check('the tools term is the core seven in pool order', first !== undefined && toolNamesOf(first).join(',') === CORE.join(','), first ? toolNamesOf(first).join(',') : 'no request')
check('each core tool rides in the profile\'s short form', first !== undefined && (first.tools ?? []).every(tool => tool.function.description === localToolForm(tool.function.name, `local/${LOCAL_FIXTURE_MODEL}`, '', {}).description))
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

section('§2 the tool contract — the short forms keep every name, type and required field of the full tools')
const cloud = await captureRoad({ road: 'zai', task: 'Read README.md and state its first heading.', reply: () => ({ kind: 'text', text: 'FIRST-CALL-DONE' }), maxTurns: 2 })
const cloudFirst = cloud.requests[0]
check('the cloud fixture turn completes on the ZAI road', cloud.code === 0 && answeredWith(cloud.stdout, 'FIRST-CALL-DONE'), cloud.stderr.slice(-300))
for (const name of CORE) {
  const short = first?.tools?.find(tool => tool.function.name === name)?.function
  const full = cloudFirst?.tools?.find(tool => tool.function.name === name)?.function
  const verdict = short !== undefined && full !== undefined ? contractHolds(short, full) : 'missing on a road'
  check(`${name}: every advertised parameter is the full tool's, type for type; required and the schema frame unchanged`, verdict === null, verdict ?? '')
}

section('§3 the prefix holds between steps — each request begins with the one before it, byte for byte')
for (let i = 1; i < mainRequests.length; i++) {
  const before = mainRequests[i - 1]!
  const after = mainRequests[i]!
  const sameTools = JSON.stringify(before.tools) === JSON.stringify(after.tools)
  const prefix = before.messages.every((message, index) => JSON.stringify(message) === JSON.stringify(after.messages[index]))
  check(`main step ${i + 1}: the tools term and the first ${before.messages.length} messages of step ${i} are unchanged`, sameTools && prefix, sameTools ? 'a message moved' : 'the tools term moved')
}
check('no system row rides after position 0 on any request', local.requests.every(request => request.messages.slice(1).every(message => message.role !== 'system')))

section('§4 a crewmate on the local model receives the profile')
const crew = crewRequests[0]
const crewSystem = crew ? systemTextOf(crew) : ''
check('RED ON A TREE WITHOUT THE PROFILE: the crewmate\'s system prompt carries the local law and the local doctrine', crewSystem.includes(LOCAL_LAW) && crewSystem.includes(LOCAL_SUBAGENT_DOCTRINE), JSON.stringify(crewSystem.slice(0, 200)))
check('the crewmate\'s prompt carries neither the cloud constitution nor the model-currency note', !crewSystem.includes(MERCURY_CONSTITUTION) && !crewSystem.includes('Model currency:'))
check('the crewmate\'s tools defer the same set (no Crewmate, Skill or Eval definition)', crew !== undefined && ['Crewmate', 'Skill', 'Eval'].every(name => !toolNamesOf(crew).includes(name)), crew ? toolNamesOf(crew).join(',') : 'no crewmate request')
console.log(`  [INFO] crewmate system ${bytes(local.normalize(crewSystem))} B · tools ${crew ? bytes(JSON.stringify(crew.tools ?? [])) : 0} B`)

section('§5 cloud models unchanged — the profile is inert off the local route, and the composition is the recorded one')
const cloudSystem = cloudFirst ? cloud.normalize(systemTextOf(cloudFirst)) : ''
if (recording) {
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, cloudSystem)
  console.log(`  [INFO] recorded ${FIXTURE} (${bytes(cloudSystem)} B) from ${dist}`)
}
const recorded = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : ''
check('the cloud system prompt is the recorded composition, byte for byte after the per-run names are normalised', cloudSystem !== '' && cloudSystem === recorded, firstDifference(cloudSystem, recorded))
const cloudOff = await captureRoad({ road: 'zai', task: 'Read README.md and state its first heading.', reply: () => ({ kind: 'text', text: 'FIRST-CALL-DONE' }), maxTurns: 2, env: { MERCURY_LOCAL_PROMPT_PROFILE: '0' } })
const offFirst = cloudOff.requests[0]
const shape = (capture: typeof cloud, request: ChatRequest | undefined): string => request === undefined ? '' : capture.normalize(JSON.stringify({ system: systemTextOf(request), tools: request.tools, reminders: reminderTextsOf(request) }))
check('the cloud request with the profile switched off is the same request, byte for byte (system, tools, roster and every reminder)', shape(cloud, cloudFirst) !== '' && shape(cloud, cloudFirst) === shape(cloudOff, offFirst), firstDifference(shape(cloud, cloudFirst), shape(cloudOff, offFirst)))

section('§6 the control arm — MERCURY_LOCAL_PROMPT_PROFILE=0 gives a local model the cloud composition')
const control = await captureRoad({ road: 'local', task: 'Read README.md and state its first heading.', reply: () => ({ kind: 'text', text: 'FIRST-CALL-DONE' }), maxTurns: 2, env: { MERCURY_LOCAL_PROMPT_PROFILE: '0' } })
const controlFirst = control.requests[0]
const controlSystem = controlFirst ? systemTextOf(controlFirst) : ''
check('the switched-off local request carries the headless constitution and the full tools', controlSystem.includes(MERCURY_HEADLESS_CONSTITUTION) && controlFirst !== undefined && toolNamesOf(controlFirst).includes('Crewmate'), controlFirst ? toolNamesOf(controlFirst).join(',') : 'no request')
console.log(`  [INFO] control arm: system ${bytes(control.normalize(controlSystem))} B · tools ${controlFirst ? bytes(JSON.stringify(controlFirst.tools ?? [])) : 0} B`)

section('§7 off the local route — a rented pod running the TensorFold recipe gets the profile; a vLLM pod keeps today\'s composition')
const podTask = 'Read README.md and state its first heading.'
const podReply = (): ScriptedReply => ({ kind: 'text', text: 'POD-DONE' })
const tfPod = await captureRoad({ road: 'pod', podEngine: 'tensorfold', task: podTask, reply: podReply, maxTurns: 2 })
const tfPodFirst = tfPod.requests[0]
const tfPodSystem = tfPodFirst ? systemTextOf(tfPodFirst) : ''
check('the TensorFold pod turn completes on the compat road', tfPod.code === 0 && answeredWith(tfPod.stdout, 'POD-DONE'), `${tfPod.stderr.slice(-300)}`)
check('RED ON A TREE WITHOUT THE POD ARM: the TensorFold pod is sent the profile — the head, the local law, the core seven in their short forms', tfPodSystem.startsWith(`Working directory: ${tfPod.cwd}\n\n${LOCAL_LAW}`) && tfPodFirst !== undefined && toolNamesOf(tfPodFirst).join(',') === CORE.join(','), tfPodFirst ? `${JSON.stringify(tfPodSystem.slice(0, 120))} · ${toolNamesOf(tfPodFirst).join(',')}` : 'no request')
const vllmPod = await captureRoad({ road: 'pod', podEngine: 'vllm', task: podTask, reply: podReply, maxTurns: 2 })
const vllmPodOff = await captureRoad({ road: 'pod', podEngine: 'vllm', task: podTask, reply: podReply, maxTurns: 2, env: { MERCURY_LOCAL_PROMPT_PROFILE: '0' } })
const vllmFirst = vllmPod.requests[0]
check('the vLLM pod keeps the cloud composition and the cloud roster (ChangeSet in full, which the profile never loads)', vllmPod.code === 0 && systemTextOf(vllmFirst ?? { model: '', messages: [] }).includes(MERCURY_HEADLESS_CONSTITUTION) && vllmFirst !== undefined && toolNamesOf(vllmFirst).includes('ChangeSet'), vllmFirst ? toolNamesOf(vllmFirst).join(',') : vllmPod.stderr.slice(-300))
check('the vLLM pod request is the same request with the profile switched off, byte for byte', shape(vllmPod, vllmFirst) !== '' && shape(vllmPod, vllmFirst) === shape(vllmPodOff, vllmPodOff.requests[0]), firstDifference(shape(vllmPod, vllmFirst), shape(vllmPodOff, vllmPodOff.requests[0])))

function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return `differ at char ${at}: ${JSON.stringify(a.slice(Math.max(0, at - 60), at + 80))} vs ${JSON.stringify(b.slice(Math.max(0, at - 60), at + 80))}`
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? '✅ THE LOCAL PROMPT PROFILE HOLDS' : `❌ ${failures} LOCAL PROMPT PROFILE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
