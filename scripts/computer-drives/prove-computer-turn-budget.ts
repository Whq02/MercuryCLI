import { rmSync } from 'node:fs'
import { check, finish, HOME, section } from '../computer/computerProofKit.ts'
import { ownerOf, toolContext } from '../computer/computerToolKit.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { CARD, CONTROL, CONTROL_BASE, DIALOG, VALUES, controlCalls, installTurnBudgetDesktop, targetCalls, type Call } from './turnBudgetFixture.ts'
import type { Message } from '../../src/types/message.ts'
import type { ToolUseContext } from '../../src/Tool.ts'

process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
seedFirstRun(HOME, [process.cwd()])
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { forgetDesktopOwner } = await import('../../src/services/desktop/desktopSession.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { query } = await import('../../src/query.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')

const fetchBefore = globalThis.fetch
const network: string[] = []
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  network.push(url.hostname)
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error(`fixture refuses network host ${url.hostname}`)
  return fetchBefore(input, init)
}, fetchBefore)

interface Result {
  id: string
  input: Call
  text: string
  rawText: string
  failed: boolean
}
interface Metrics {
  calls: number
  callsUntilValuesRead: number | null
  resultCharacters: number
  resultBytes: number
  rawResultCharacters: number
  rawResultBytes: number
  refusals: number
  shapeRefusals: number
  identicalRepeats: number
  identicalPixelClicks: number
  identicalTriggerClicks: number
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
}

function portableText(text: string): string {
  return text.replaceAll(HOME, '<fixture-home>').replace(/\d{13}-display-(\d+)/g, '<capture>-display-$1')
}

function actsOf(input: Call): Call[] {
  if (input.action === 'sequence') return (input.steps as Call[]).flatMap(actsOf)
  return ['click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll', 'type', 'key', 'hold', 'focusApp'].includes(String(input.action)) ? [input] : []
}

function metrics(results: Result[]): Metrics {
  const counts = new Map<string, number>()
  let identicalRepeats = 0
  for (const result of results) for (const act of actsOf(result.input)) {
    const { capture, settleMs, scale, full, display, verify, label, ...semantic } = act
    const key = JSON.stringify(semantic)
    const prior = counts.get(key) ?? 0
    if (prior > 0) identicalRepeats++
    counts.set(key, prior + 1)
  }
  let readAt: number | null = null
  let seen = ''
  for (const [i, result] of results.entries()) {
    if (!result.failed) seen += `\n${result.rawText}`
    if (readAt === null && VALUES.every(value => seen.includes(value))) readAt = i + 1
  }
  return {
    calls: results.length,
    callsUntilValuesRead: readAt,
    resultCharacters: results.reduce((sum, row) => sum + row.text.length, 0),
    resultBytes: results.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0),
    rawResultCharacters: results.reduce((sum, row) => sum + row.rawText.length, 0),
    rawResultBytes: results.reduce((sum, row) => sum + Buffer.byteLength(row.rawText), 0),
    refusals: results.filter(row => row.failed).length,
    shapeRefusals: results.filter(row => row.failed && /does not take|must be an act|depth.*outside|invalid.*(?:input|action)|unrecognized|Invalid enum|Invalid option|Invalid input|Unknown key|parameter.*(?:not expected|must be)/i.test(row.text)).length,
    identicalRepeats,
    identicalPixelClicks: counts.get(JSON.stringify({ action: 'click', x: 380, y: 183 })) ?? 0,
    identicalTriggerClicks: counts.get(JSON.stringify({ action: 'click', target: { role: 'AXButton', name: 'When a webhook fires' } })) ?? 0,
  }
}

async function run(replay: boolean) {
  resetDesktopDriverForTest()
  const resolution = resolveDesktopDriver()
  if (resolution.state !== 'ok' || resolution.driver.describe().kind !== 'fake') throw new Error('the turn-budget drive requires the fixture desktop')
  const desktop = installTurnBudgetDesktop(resolution.driver)
  const calls = replay ? controlCalls() : targetCalls()
  const results: Result[] = []
  const issued = new Map<string, Call>()
  let cardRef: number | null = null
  const turns: ScriptedTurn[] = calls.map((input, index) => ({
    kind: 'tool_use',
    name: 'Computer',
    id: `toolu_budget_${replay ? 'control' : 'target'}_${index}`,
    model: 'claude-fable-5-1',
    get input() {
      desktop.beforeCall(index, replay)
      if (!replay && index === 3) return { ...input, ref: cardRef ?? 0 }
      return input
    },
  }))
  turns.push({ kind: 'text', text: 'The scripted requests have ended.', model: 'claude-fable-5-1' })
  const api = await startFixtureApi(turns, { apiChecks: true })
  process.env.ANTHROPIC_BASE_URL = api.url
  const initial = getDefaultAppState()
  let state: ReturnType<typeof getDefaultAppState> = { ...initial, toolPermissionContext: { ...initial.toolPermissionContext, mode: 'sovereign' } }
  const base = toolContext({ model: 'claude-fable-5-1' })
  const context: ToolUseContext = {
    ...base,
    options: { ...base.options, tools: [ComputerTool], thinkingConfig: { type: 'adaptive' } },
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    setInProgressToolUseIDs: () => {},
  }
  const owner = ownerOf(context)
  forgetDesktopOwner(owner)
  const deadline = setTimeout(() => context.abortController.abort(), 180_000)
  let final = false
  try {
    const iterator = query({
      messages: [createUserMessage({ content: 'Read both labelled webhook values from the automation configuration in the fixture browser. Use only Computer.' })],
      systemPrompt: asSystemPrompt([await ComputerTool.prompt()]),
      userContext: {}, systemContext: {},
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      toolUseContext: context,
      querySource: 'main_thread',
    })
    for await (const event of iterator) {
      const row = event as Message
      if (row.type !== 'assistant' && row.type !== 'user') continue
      const content = row.message.content
      if (row.type === 'assistant') {
        if (textOf(content).includes('The scripted requests have ended.')) final = true
        if (Array.isArray(content)) for (const block of content) if (block.type === 'tool_use') issued.set(block.id, block.input as Call)
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_result' || results.some(result => result.id === block.tool_use_id)) continue
        const input = issued.get(block.tool_use_id)
        if (!input) throw new Error(`result without a model request: ${block.tool_use_id}`)
        const rawText = textOf(block.content)
        const output = row.toolUseResult as { outcome?: string } | undefined
        const result: Result = { id: block.tool_use_id, input, rawText, text: portableText(rawText), failed: block.is_error === true || output?.outcome === 'failed' }
        results.push(result)
        if (!replay && input.action === 'tree') {
          const cardLine = rawText.split('\n').find(line => line.includes('AXButton') && line.includes(JSON.stringify(CARD)))
          const match = cardLine?.match(/\[(\d+)\]/)
          cardRef = match ? Number(match[1]) : null
        }
      }
    }
    const wire = new Map<string, string>()
    for (const request of api.messageRequests()) {
      const body = request.body as { messages?: Array<{ role: string; content: unknown }> }
      for (const message of body.messages ?? []) if (message.role === 'user' && Array.isArray(message.content)) for (const block of message.content) if (block.type === 'tool_result' && !wire.has(block.tool_use_id)) wire.set(block.tool_use_id, textOf(block.content))
    }
    check(`${replay ? 'control' : 'target'}: every scripted call settled and reached the next model request`, final && results.length === calls.length && results.every(row => wire.has(row.id)) && api.refusals.length === 0, `${results.length}/${calls.length}; wire ${wire.size}; API refusals ${api.refusals.length}`)
    for (const result of results) {
      result.rawText = wire.get(result.id) ?? ''
      result.text = portableText(result.rawText)
    }
    return { results, metrics: metrics(results), desktop, cardRef }
  } finally {
    clearTimeout(deadline)
    forgetDesktopOwner(owner)
    await api.close()
    await resolution.driver.close()
  }
}

try {
  section(`Recorded 44-call input replay; synthetic desktop; baseline ${CONTROL_BASE}`)
  console.log('Each result is counted once, from its first model request; byte pins replace only the scratch home and screenshot clock. Images are excluded. Repeats count requested acts, including sequence steps.')
  const control = await run(true)
  console.log(`CONTROL ${JSON.stringify(control.metrics)}`)
  console.log(`FIXTURE ${JSON.stringify(control.desktop.shape())}`)
  for (const [i, result] of control.results.entries()) if (result.failed) console.log(`  refusal #${i + 10}: ${result.text.split('\n').slice(-1)[0]}`)
  check('the complete forty-four-call stretch ran', control.metrics.calls === CONTROL.calls)
  check('the replay carries ten identical card clicks and ten identical trigger clicks', control.metrics.identicalPixelClicks === CONTROL.identicalPixelClicks && control.metrics.identicalTriggerClicks === CONTROL.identicalTriggerClicks, JSON.stringify(control.metrics))
  check('the own-terminal and changed-window guards still refuse', control.results[2]?.failed === true && /terminal running this session/.test(control.results[2]!.text) && control.results[43]?.failed === true && /front window changed/.test(control.results[43]!.text))
  check('the replay never reads both complete values', control.metrics.callsUntilValuesRead === null)
  if (process.argv.includes('--control')) {
    check('the measured baseline has eleven refusals, five for shapes', control.metrics.refusals === CONTROL.refusals && control.metrics.shapeRefusals === CONTROL.shapeRefusals, JSON.stringify(control.metrics))
    check('the measured baseline byte and character counts are pinned', control.metrics.resultBytes === CONTROL.resultBytes && control.metrics.resultCharacters === CONTROL.resultCharacters, JSON.stringify(control.metrics))
  } else {
    section('A–C target: the same desktop, using the new results rather than repeated coordinates')
    const target = await run(false)
    console.log(`TARGET ${JSON.stringify(target.metrics)}`)
    for (const [i, result] of target.results.entries()) console.log(`  target ${i + 1}: ${result.text.split('\n').slice(0, 2).join(' | ').slice(0, 500)}`)
    check('[A+C] both complete labelled values reach the model within eight calls', target.metrics.callsUntilValuesRead !== null && target.metrics.callsUntilValuesRead <= 8, JSON.stringify(target.metrics))
    check('[A+B+C] result bytes are below one quarter of the measured control', target.metrics.callsUntilValuesRead !== null && target.metrics.resultBytes < CONTROL.resultBytes * 0.25, `${target.metrics.resultBytes} < ${CONTROL.resultBytes} / 4`)
    check('[C] capture options, clamped depth, screenshot step, wait title and read have zero shape refusals', target.metrics.shapeRefusals === 0 && target.metrics.refusals === 0, JSON.stringify(target.metrics))
    check('[A+B+C] zero identical repeated acts', target.metrics.identicalRepeats === 0, JSON.stringify(target.metrics))
    check('[A] the card is selected by a ref read from the scoped outline', target.cardRef !== null && target.cardRef > 0 && target.results[3]?.input.ref === target.cardRef && target.results[3]?.failed === false)
    check('[B] navigation reports the destination window', /now: window "Automations"/.test(target.results[1]?.text ?? ''), target.results[1]?.text)
    check('[B] opening the card reports its dialog after the click', (target.results[3]?.text ?? '').includes(`dialog "${DIALOG}"`), target.results[3]?.text)
    check('[C] native-length reads return the values rather than the clipped tree prefixes', target.desktop.traces.filter(row => row.action === 'readElement').length === 2 && target.results.slice(-2).every((row, i) => !row.failed && row.rawText.includes(VALUES[i]!)))
  }
  check('provider traffic stayed on loopback', network.length > 0 && network.every(host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host)), network.join(','))
} finally {
  globalThis.fetch = fetchBefore
  await flushSessionStorage()
  rmSync(HOME, { recursive: true, force: true })
}
finish('prove-computer-turn-budget')
