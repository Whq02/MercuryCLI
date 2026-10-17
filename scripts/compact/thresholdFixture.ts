import { roughTokenCountEstimationForMessages } from '../../src/services/tokenEstimation.ts'
import { requestGaugeDigest } from '../../src/services/run/requestGauge.ts'
import { tokenCountWithEstimation } from '../../src/utils/tokens.ts'
import { createUserMessage } from '../../src/utils/messages.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'

const WORDS = ['const', 'function', 'return', 'await', 'import', 'export', 'messages', 'context', 'window', 'tokens', 'result', 'fold', 'gauge', 'request', 'summary', 'ladder', 'room', 'limit', 'line', 'read', 'if', 'for', 'of', 'string', 'number', '=>', '===', '&&', 'null', 'undefined']

function sourceLines(chars: number, seed: number): string {
  let out = ''
  let n = 0
  let x = seed
  const next = (): number => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return x
  }
  while (out.length < chars) {
    const words = 2 + (next() % 11)
    const parts: string[] = []
    for (let w = 0; w < words; w++) parts.push(WORDS[next() % WORDS.length]!)
    const tail = next() % 4
    out += `${++n}\t${'  '.repeat(next() % 4)}${parts.join(' ')}${tail === 0 ? ' {' : tail === 1 ? ' }' : tail === 2 ? ';' : ''}\n`
  }
  return out.slice(0, chars)
}

type ThresholdConversation = { messages: Message[]; ids: string[]; paths: string[]; results: string[]; anchor: AssistantMessage; gauge: number; byDensity: number }
type ThresholdRig = { model: string; family: string; resultChars: number; fixed: number; ratio: number; target: number; stamp?: (row: AssistantMessage, index: number) => void }

let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-b000-${String(++uuidSeq).padStart(12, '0')}`

export function conversationAtThreshold(rig: ThresholdRig): ThresholdConversation {
  const messages: Message[] = [createUserMessage({ content: 'Read the sources under src/services and write the memo on the fold ladder; cite file and line for every claim.' })]
  const ids: string[] = []
  const paths: string[] = []
  const results: string[] = []
  let anchor: AssistantMessage | undefined
  let raw = roughTokenCountEstimationForMessages(messages)
  for (let i = 0; i < 400; i++) {
    const id = `toolu_fixture_${String(i).padStart(4, '0')}`
    const path = `/fixture/src/services/module-${String(i + 1).padStart(3, '0')}.ts`
    const thought = `Round ${i}: the previous file settled the ${WORDS[i % WORDS.length]} question; the next source to read is module ${i + 1}, whose exports the memo cites. ${sourceLines(220, 7 + i).replace(/\n/g, ' ')}`
    const row = {
      type: 'assistant',
      uuid: nextUuid(),
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${String(i).padStart(4, '0')}`,
        type: 'message',
        role: 'assistant',
        model: rig.model,
        content: [
          { type: 'thinking', thinking: thought, signature: `fixture-signature-round-${i}` },
          { type: 'text', text: `Reading module ${i + 1} next.` },
          { type: 'tool_use', id, name: 'Read', input: { file_path: path } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1200 + i * 10, output_tokens: 160, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    } as unknown as AssistantMessage
    rig.stamp?.(row, i)
    const body = sourceLines(rig.resultChars, 1000 + i)
    const pair = [row, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: body }] as never })] as Message[]
    const added = roughTokenCountEstimationForMessages(pair)
    if (anchor !== undefined && rig.fixed + Math.ceil((raw + added) * rig.ratio) > rig.target - 1_500) break
    raw += added
    messages.push(...pair)
    ids.push(id)
    paths.push(path)
    results.push(body)
    anchor = row
  }
  const last = anchor as AssistantMessage
  const first = messages.indexOf(last as Message)
  ;(last as AssistantMessage & { contextGauge?: unknown }).contextGauge = { version: 1, key: `${rig.family}:${rig.model}:c1`, epoch: 0, digest: requestGaugeDigest(messages.slice(0, first)), rawTokens: 0, fixed: { digest: 'fixed-material', tokens: rig.fixed }, density: { ratio: rig.ratio, samples: 24, residuals: [] }, sample: { eligible: true, denominator: 20_000, measured: Math.round(20_000 * rig.ratio), reason: 'matched-request-tail' } }
  const usage = last.message.usage as { input_tokens: number }
  usage.input_tokens = 1
  const read = tokenCountWithEstimation(messages, rig.model)
  usage.input_tokens = Math.max(1, 1 + rig.target - read)
  const gauge = tokenCountWithEstimation(messages, rig.model)
  return { messages, ids, paths, results, anchor: last, gauge, byDensity: rig.fixed + Math.ceil(raw * rig.ratio) }
}
