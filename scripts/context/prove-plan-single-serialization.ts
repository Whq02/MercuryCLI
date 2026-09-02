#!/usr/bin/env bun
import { createHash } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type AnyMessage = Record<string, unknown>

function oracleDigest(messages: AnyMessage[]): string {
  const h = createHash('sha256')
  for (const m of messages) {
    const type = (m as { type?: string }).type ?? '?'
    const content = (m as { message?: { content?: unknown } }).message?.content ?? null
    h.update(type)
    h.update('\u0000')
    h.update(JSON.stringify(content) ?? 'null')
    h.update('\u0001')
  }
  return h.digest('hex')
}
function oracleChars(messages: AnyMessage[]): number {
  let chars = 0
  for (const m of messages) {
    const content = (m as { message?: { content?: unknown } }).message?.content
    chars += typeof content === 'string' ? content.length : (JSON.stringify(content ?? null)?.length ?? 0)
  }
  return chars
}

function fixtureMessages(): AnyMessage[] {
  const now = Date.now()
  const out: AnyMessage[] = []
  for (let i = 0; i < 40; i++) {
    out.push({
      type: 'user',
      uuid: `u-${i}`,
      timestamp: new Date(now - 1000 * (80 - i)).toISOString(),
      message: {
        role: 'user',
        content:
          i % 4 === 0
            ? `plain prompt ${i} with some words é⚡ `.repeat(8)
            : [
                { type: 'text', text: `block ${i} `.repeat(30) },
                { type: 'tool_result', tool_use_id: `tu-${i}`, content: `result ${i} `.repeat(60) },
              ],
      },
    })
    out.push({
      type: 'assistant',
      uuid: `a-${i}`,
      timestamp: new Date(now - 1000 * (80 - i) + 500).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${i} `.repeat(40) }],
      },
    })
  }
  return out
}

async function main(): Promise<void> {
  const ok = await import('../../src/services/run/ownerKey.js')
  const planMod = await import('../../src/services/run/requestContextPlan.js')
  const cal = await import('../../src/services/run/contextCalibration.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'single-serialization', lane: 'main' })
  const skip = new Set<string>()
  const KEY = 'prover:single-serialization:v1'

  const messages = fixtureMessages()
  const build = (withKey: boolean) =>
    planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'repl_main_thread' as never,
        contentReplacementState: undefined,
        skipToolNames: skip,
        calibrationKey: withKey ? KEY : null,
      },
      'inspect',
    )

  section('P1 · digest byte-parity with the previous two-pass algorithm')
  const plan = await build(true)
  {
    const expected = oracleDigest(plan.messages as never)
    check('plan.digest equals the oracle digest byte-for-byte', plan.digest === expected, `plan=${plan.digest} oracle=${expected}`)
    check('digest is 64 hex chars (not vacuous)', /^[0-9a-f]{64}$/.test(plan.digest))
  }

  section('P2 · estimate arithmetic parity with the previous loop')
  {
    const est = plan.tokenEstimate
    check('tokenEstimate present when a calibration key rides the input', est !== null)
    if (est) {
      const expected = cal.estimateTokensFromChars(oracleChars(plan.messages as never), cal.calibrationFor(KEY))
      check(
        'estimatedTokens equals the previous arithmetic exactly (raw length for strings, serialized length otherwise)',
        est.estimatedTokens === expected,
        `plan=${est.estimatedTokens} oracle=${expected}`,
      )
      check('the estimate is non-zero over a non-empty view', est.estimatedTokens > 0)
    }
  }

  section('P3 · counted operations — the estimate adds ZERO extra stringify calls')
  {
    await build(true)
    await build(false)
    const real = JSON.stringify.bind(JSON)
    let count = 0
    ;(JSON as { stringify: typeof JSON.stringify }).stringify = ((...args: unknown[]) => {
      count++
      return (real as (...a: unknown[]) => string)(...args)
    }) as typeof JSON.stringify
    try {
      count = 0
      await build(true)
      const withKey = count
      count = 0
      await build(false)
      const withoutKey = count
      const detail = `withKey=${withKey} withoutKey=${withoutKey} (pre-fuse shape: +${plan.messages.length - Math.ceil(plan.messages.length / 8)}-ish for the estimate walk)`
      console.log(`  · stringify calls: ${detail}`)
      check('a calibrated build stringifies EXACTLY as often as an uncalibrated one', withKey === withoutKey, detail)
      check('the instrument observed real work (not vacuous)', withKey > 0, detail)
    } finally {
      ;(JSON as { stringify: typeof JSON.stringify }).stringify = real
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(` ${checks} checks, ${failures} failures`)
  console.log('='.repeat(60))
  process.exit(failures > 0 ? 1 : 0)
}

void main()
