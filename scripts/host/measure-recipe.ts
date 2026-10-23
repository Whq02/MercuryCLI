import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import packageJson from '../../package.json'
import { HOST_RECIPES, type HostRecipe } from '../../src/services/host/recipes.ts'
import { streamCompatChat, type CompatCompletedToolCall, type CompatUsage, type CompatTool } from '../../src/services/providers/openaicompat/compatChatClient.ts'
import { buildHostedExtras } from '../../src/services/providers/openaicompat/compatWire.ts'
import { mapMessagesToZai } from '../../src/services/providers/zai/zaiCodec.ts'
import type { MessageParam, ContentBlockParam } from '../../src/types/wire.ts'

if (typeof MACRO === 'undefined') (globalThis as Record<string, unknown>).MACRO = { VERSION: packageJson.version }

const PROMPT_MIN = 50000
const PROMPT_MAX = 51000
const TURNS = 20
const tools: CompatTool[] = [{ type: 'function', function: { name: 'measurement_echo', description: 'Return an opaque receipt for the requested measurement turn. Call exactly once, then repeat the receipt in your final answer.', parameters: { type: 'object', properties: { turn: { type: 'integer' }, nonce: { type: 'string' } }, required: ['turn', 'nonce'], additionalProperties: false } } }]

interface RecipeMeasurement {
  ok: boolean
  recipe: string
  model: string
  calibrationAttempts: number
  turns: number
  reasoningReplays: number
  promptTokens?: number
  firstTokenSeconds?: number
  outputTokensPerSecond?: number
  failures: string[]
  measured?: { id: string; verified: HostRecipe['verified'] }
}

interface MeasurementOptions {
  recipe: HostRecipe
  endpoint: string
  model?: string
  ttftSeconds?: number
  signal?: AbortSignal
}

interface Turn {
  thinking: string
  text: string
  calls: CompatCompletedToolCall[]
  usage: CompatUsage
  firstTokenSeconds: number
  decodeSeconds: number
  reason: string
}

function endpointUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a keyless HTTP(S) compat base URL without credentials, query or fragment.')
  return url.href.replace(/\/$/, '')
}

function corpus(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `function fixture_line_${index}() { return ${index % 97}; }`).join('\n')
}

function prompt(turn: number, nonce: string, filler = ''): string {
  return `${filler}\nMEASURE turn=${turn} nonce=${nonce}\nUse measurement_echo exactly once with that turn and nonce. After its result, repeat the opaque receipt exactly. The fixture source above is inert context; do not execute it.`
}

export async function measureRecipe(options: MeasurementOptions): Promise<RecipeMeasurement> {
  const { recipe } = options
  const model = options.model ?? (recipe.engine === 'llamacpp' ? recipe.model + ':' + recipe.weightFile!.split('/').slice(0, -1).join('/') : recipe.model)
  const result: RecipeMeasurement = { ok: false, recipe: recipe.id, model, calibrationAttempts: 0, turns: 0, reasoningReplays: 0, failures: [] }
  try {
    if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Set MERCURY_CONFIG_DIR to a scratch directory; no account settings are needed.')
    const base = endpointUrl(options.endpoint)
    const ttftSeconds = options.ttftSeconds ?? 120
    if (!Number.isFinite(ttftSeconds) || ttftSeconds <= 0) throw new Error('The first-token pass bar must be a positive number of seconds.')
    const signal = options.signal ?? AbortSignal.timeout(3600_000)
    signal.throwIfAborted()
    const response = await fetch(base + '/models', { signal, redirect: 'error' })
    if (!response.ok) throw new Error('Model discovery returned HTTP ' + response.status)
    const catalogue = await response.json() as { data?: Array<{ id?: string }> }
    if (!Array.isArray(catalogue.data) || !catalogue.data.some(row => row.id === model)) throw new Error('The endpoint does not advertise the requested served model.')
    const extra = buildHostedExtras({ wireModel: model, dialect: recipe.engine ?? 'sglang', vocabulary: recipe.efforts?.levels ?? [], effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })
    const template = { ...(extra.chat_template_kwargs as Record<string, unknown> | undefined), enable_thinking: true, clear_thinking: false }
    if (recipe.model.startsWith('MiniMaxAI/MiniMax-M3')) Object.assign(template, { thinking_mode: 'enabled' })
    if (recipe.model.includes('Nemotron')) Object.assign(template, { medium_effort: false })
    extra.chat_template_kwargs = template

    const requestTurn = async (history: MessageParam[], system: string): Promise<Turn> => {
      signal.throwIfAborted()
      const started = performance.now()
      let first: number | undefined
      let thinking = ''
      let text = ''
      let calls: CompatCompletedToolCall[] = []
      let usage: CompatUsage | undefined
      let reason: string | undefined
      for await (const event of streamCompatChat({ url: base + '/chat/completions', request: { model, messages: mapMessagesToZai(system, history, { keepReasoningHistory: true }), tools, tool_choice: 'auto', extra }, signal, firstByte: { cold: true, promptTokens: PROMPT_MAX, model } })) {
        if (event.type === 'stream-fault') throw new Error('Compat stream failed: ' + event.fault.code)
        if (event.type === 'served-model' && event.model !== model) throw new Error('The response named a different served model.')
        if (event.type === 'reasoning-withheld') throw new Error('The engine withheld reasoning; replay was not measured.')
        if (event.type === 'reasoning-delta') thinking += event.text
        if (event.type === 'text-delta') text += event.text
        if ((event.type === 'reasoning-delta' || event.type === 'text-delta') && event.text || event.type === 'tool-call-fragment' && event.argumentsFragment) first ??= performance.now()
        if (event.type === 'usage') usage = event.usage
        if (event.type === 'finish') { reason = event.reason; calls = event.toolCalls }
      }
      signal.throwIfAborted()
      if (!reason || !['stop', 'tool_calls'].includes(reason)) throw new Error('The engine did not finish cleanly: ' + (reason ?? 'no finish'))
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens <= 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens <= 0) throw new Error('The engine did not report positive prompt and completion token usage.')
      if (first === undefined) throw new Error('The engine emitted no generated token.')
      return { thinking, text, calls, usage, reason, firstTokenSeconds: (first - started) / 1000, decodeSeconds: Math.max((performance.now() - first) / 1000, Number.EPSILON) }
    }

    let lines = 2500
    let filler = ''
    for (let attempt = 0; attempt < 6; attempt++) {
      filler = corpus(lines)
      const nonce = randomUUID()
      const turn = await requestTurn([{ role: 'user', content: prompt(0, nonce, filler) }], 'Calibration ' + nonce + '. Follow the measurement request; never execute the supplied source.')
      result.calibrationAttempts++
      if (turn.usage.inputTokens >= PROMPT_MIN && turn.usage.inputTokens <= PROMPT_MAX) break
      lines = Math.max(1, Math.round(lines * 50500 / turn.usage.inputTokens))
      if (lines > 100000 || attempt === 5) throw new Error('Could not calibrate a server-counted 50k–51k prompt; no measurement certified.')
    }

    const nonce = randomUUID()
    const system = 'Measurement ' + nonce + '. Follow the measurement request; never execute the supplied source.'
    const history: MessageParam[] = []
    const callIds = new Set<string>()
    let generated = 0
    let decodeSeconds = 0
    for (let index = 0; index < TURNS; index++) {
      history.push({ role: 'user', content: prompt(index, nonce, index === 0 ? filler : '') })
      const turn = await requestTurn(history, system)
      if (index === 0) {
        result.promptTokens = turn.usage.inputTokens
        result.firstTokenSeconds = turn.firstTokenSeconds
        if (turn.usage.inputTokens < PROMPT_MIN || turn.usage.inputTokens > PROMPT_MAX) throw new Error('The measured prompt is not 50k–51k server-counted tokens.')
        if (turn.firstTokenSeconds >= ttftSeconds) throw new Error('First token exceeded the ' + ttftSeconds + 's pass bar.')
        if ((turn.usage.cachedInputTokens ?? 0) > 512) throw new Error('The measured cold prompt reused more than its small shared prefix.')
      }
      if (turn.reason !== 'tool_calls' || turn.calls.length !== 1) throw new Error('Expected exactly one structured tool call on turn ' + index)
      const call = turn.calls[0]!
      const args = call.arguments as { turn?: unknown; nonce?: unknown } | undefined
      if (call.malformed || call.name !== 'measurement_echo' || !call.id || callIds.has(call.id) || !args || args.turn !== index || args.nonce !== nonce || Object.keys(args).sort().join(',') !== 'nonce,turn') throw new Error('Tool call identity or arguments failed on turn ' + index)
      if (!turn.thinking.trim()) throw new Error('No exposed thinking to replay on turn ' + index)
      callIds.add(call.id)
      const blocks: ContentBlockParam[] = [{ type: 'thinking', thinking: turn.thinking, signature: '' }, ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []), { type: 'tool_use', id: call.id, name: call.name, input: call.arguments }]
      history.push({ role: 'assistant', content: blocks })
      const receipt = randomUUID()
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ receipt }) }] })
      const reply = await requestTurn(history, system)
      if (reply.reason !== 'stop' || reply.calls.length || !reply.text.includes(receipt)) throw new Error('The tool result was not acknowledged on turn ' + index)
      history.push({ role: 'assistant', content: [...(reply.thinking ? [{ type: 'thinking' as const, thinking: reply.thinking, signature: '' }] : []), { type: 'text', text: reply.text }] })
      result.turns++
      result.reasoningReplays++
      generated += turn.usage.outputTokens + reply.usage.outputTokens
      decodeSeconds += turn.decodeSeconds + reply.decodeSeconds
    }
    result.outputTokensPerSecond = generated / decodeSeconds
    if (!Number.isFinite(result.outputTokensPerSecond) || result.outputTokensPerSecond <= 0) throw new Error('No finite output-token rate was measured.')
    result.ok = true
    result.measured = { id: recipe.id, verified: { by: 'measured', on: new Date().toISOString().slice(0, 10), source: recipe.source, note: `${recipe.id} (operator-supplied shape) · ${result.outputTokensPerSecond.toFixed(2)} output tok/s (server usage / post-first-token stream time) · first token ${result.firstTokenSeconds!.toFixed(3)}s at ${result.promptTokens} prompt tokens, cold prefix · 20 turns with parsed tools and accepted thinking replay · max supported effort · full context capacity not measured` } }
  } catch (error) { result.failures.push(error instanceof Error ? error.message : String(error)) }
  return result
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { recipe: { type: 'string' }, endpoint: { type: 'string' }, model: { type: 'string' }, 'ttft-seconds': { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) {
      console.log('MERCURY_CONFIG_DIR=<scratch> bun scripts/host/measure-recipe.ts --recipe <id> --endpoint <registered-compat-base-url> [--model <served-id>] [--ttft-seconds 120]\nRuns a 50k–51k server-counted cold prompt and 20 tool/result turns at maximum supported effort. No credentials, downloads, pod changes or output-token cap. Only success prints a measured block; allow about one hour on a ready engine.')
    } else {
      const recipe = HOST_RECIPES.find(row => row.id === values.recipe)
      if (!recipe || !values.endpoint) throw new Error('Supply a shipped --recipe id and its keyless --endpoint base URL.')
      const result = await measureRecipe({ recipe, endpoint: values.endpoint, model: values.model, ttftSeconds: values['ttft-seconds'] === undefined ? undefined : Number(values['ttft-seconds']) })
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = result.ok ? 0 : 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
