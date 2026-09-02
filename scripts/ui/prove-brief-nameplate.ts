#!/usr/bin/env bun
// prove-brief-nameplate.ts — the SendUserMessage row carries the [Mercury]
// transcript nameplate (operator report: with dropTextInBriefTurns
// hiding the assistant's own text, a SendUserMessage session rendered EVERY
// reply un-attributed — "no name-tags").
//
//   §1 fork + sentAt ⇒ the plate: HH:MM:SS [Mercury] leads the row, clock
//      derived from the tool's OWN sentAt (formatClock parity, never a guess).
//   §2 fork + NO sentAt ⇒ honest self-omit (no plate, message still renders)
//      — the same rule AssistantTextMessage's nameplate follows.
//   §3 bare-stamp ⇒ the bare block, byte-identical shape (no Mercury).
//   §4 brief-only chat view keeps its own Mercury label (unchanged).

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { renderToolResultMessage } = await import('../../src/tools/BriefTool/UI.js')
const { formatClock } = await import('../../src/components/messages/TranscriptNameplate.js')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// Collect every string reachable in a React element tree (children walk).
function texts(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const c of node) texts(c, out)
    return out
  }
  if (typeof node === 'object') {
    const props = (node as { props?: { children?: unknown; leadingInline?: unknown } }).props
    if (props && 'children' in props) texts(props.children, out)
    // The nameplate rides Markdown's leadingInline PROP, not children.
    if (props && 'leadingInline' in props) texts(props.leadingInline, out)
  }
  return out
}

const SENT_AT = '2026-07-06T10:20:30.000Z'
const expectedClock = formatClock(SENT_AT)!

console.log('§1 fork + sentAt ⇒ HH:MM:SS [Mercury] plate')
{
  const el = renderToolResultMessage({ message: 'reading you clear', sentAt: SENT_AT } as never, [], {})
  const all = texts(el).join('')
  t('plate name present', all.includes('Mercury'), all.slice(0, 120))
  t('clock from the tool sentAt (formatClock parity)', all.includes(expectedClock), `expect ${expectedClock}`)
  t('bracket chrome present', all.includes('[') && all.includes('] '))
  t('message body present', all.includes('reading you clear'))
}

console.log('§2 fork + no sentAt ⇒ self-omit (no fabricated stamp)')
{
  const el = renderToolResultMessage({ message: 'no stamp on this one' } as never, [], {})
  const all = texts(el).join('')
  t('no plate without an honest timestamp', !all.includes('Mercury'), all.slice(0, 120))
  t('message still renders', all.includes('no stamp on this one'))
}

console.log('§3 bare stamp ⇒ plate STILL renders (stamp-independence)')
{
  // presentation is
  // stamp-independent.
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-src' }
  const el = renderToolResultMessage({ message: 'base shape', sentAt: SENT_AT } as never, [], {})
  const all = texts(el).join('')
  t('Mercury plate present under a bare stamp', all.includes('Mercury'), all.slice(0, 120))
  t('body renders', all.includes('base shape'))
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
}

console.log('§4 brief-only chat view keeps its own label')
{
  const el = renderToolResultMessage({ message: 'chat view', sentAt: SENT_AT } as never, [], { isBriefOnly: true })
  const all = texts(el).join('')
  t('brief-only Mercury label unchanged', all.includes('Mercury') && all.includes('chat view'))
}

if (fail) {
  console.log('❌ BRIEF-NAMEPLATE PROOF FAILED')
  process.exit(1)
}
console.log('✅ BRIEF-NAMEPLATE PROOFS PASS')
