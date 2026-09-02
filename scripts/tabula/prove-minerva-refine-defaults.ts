#!/usr/bin/env bun
// ============================================================================
//  prove-minerva-refine-defaults — refine defaults its target and speaks
//  the operator's language (operator-sighted, ruled).
//
//  The sighting: the panel painted "✕ refine without id" — the raw internal
//  validator reason. The mechanism: the output schema requires only `op`,
//  so the model may legitimately omit the id on a refine (the operator said
//  "refine that" over an obvious target); the validator then refused the
//  WHOLE plan with its internal string, and both panels (the console rail,
//  the workbench MINERVA tab) painted it verbatim. The plumbing half
//  verified clean: no road drops an id — the gap was model-omission vs
//  validator-strictness.
//
//  The ruled design: (1) with exactly one live target an id-less refine
//  DEFAULTS to it; (2) with several, the refine drops ALONE with plain
//  words naming the count — the rest of the plan lands; (3) the failure
//  words are the estate's voice at their ONE owner (the validators), so
//  every panel inherits them — the internal strings die.
//
//  §1 chat leg: one note — the id-less refine defaults and lands
//  §2 chat leg: three notes — the refine drops alone, named; adds survive
//  §3 room leg: the same law over saved prompts (the ruled sentence)
//  §4 the internal strings are gone from both validators
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateMinervaChatPlan } from '../../src/utils/tabula/minerva.ts'
import { validateMinervaRoomPlan } from '../../src/utils/tabula/minervaRoom.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const ONE = new Set(['note-a'])
const THREE = new Set(['note-a', 'note-b', 'note-c'])

// §1 one live note — the id-less refine defaults
{
  const r = validateMinervaChatPlan(
    { ops: [{ op: 'refine', refinedText: 'Sharpen the cache investigation into one fireable prompt.' }], reply: 'refined it' },
    ONE,
  )
  t('§1 the plan is accepted', r.ok === true, r.ok ? '' : (r as { reason: string }).reason)
  if (r.ok) {
    const refine = r.plan.ops.find(o => o.op === 'refine') as { op: 'refine'; id: string } | undefined
    t('§1 …with the refine defaulted onto the one live note', refine?.id === 'note-a', JSON.stringify(r.plan.ops))
  }
}

// §2 three live notes — the refine drops alone with the words; the add lands
{
  const r = validateMinervaChatPlan(
    {
      ops: [
        { op: 'add', text: 'a fresh intention' },
        { op: 'refine', refinedText: 'Sharpen something.' },
      ],
      reply: 'done',
    },
    THREE,
  )
  t('§2 the plan is accepted (never refused whole)', r.ok === true, r.ok ? '' : (r as { reason: string }).reason)
  if (r.ok) {
    t('§2 …the add survives', r.plan.ops.some(o => o.op === 'add'))
    t('§2 …the ambiguous refine dropped alone', !r.plan.ops.some(o => o.op === 'refine'))
    t('§2 …with plain words naming the count', r.dropped.some(d => d.includes('refine needs a note number') && d.includes('3')), r.dropped.join(' | '))
  }
}

// §3 the room leg over saved prompts
{
  const oneLive = [{ id: 'sp-1' }]
  const r1 = validateMinervaRoomPlan(
    { refinements: [{ prompt: '', refinedText: 'Rebuild the saved prompt as a fireable one.' }], reply: 'refined' },
    oneLive,
  )
  t('§3 one saved prompt: the handle-less refinement defaults', r1.ok === true && (r1 as { plan: { refinements: Array<{ id: string }> } }).plan.refinements[0]?.id === 'sp-1', r1.ok ? JSON.stringify((r1 as { plan: unknown }).plan) : (r1 as { reason: string }).reason)

  const threeLive = [{ id: 'sp-1' }, { id: 'sp-2' }, { id: 'sp-3' }]
  const r3 = validateMinervaRoomPlan(
    { refinements: [{ prompt: '', refinedText: 'Rebuild it.' }], reply: 'refined' },
    threeLive,
  )
  t('§3 three saved prompts: the plan lands with the refinement dropped, named in the ruled voice', r3.ok === true && (r3 as { dropped: string[] }).dropped.some(d => d.includes('refine needs a prompt number') && d.includes('3 saved')), r3.ok ? (r3 as { dropped: string[] }).dropped.join(' | ') : (r3 as { reason: string }).reason)
}

// §4 the internal strings are gone
{
  const chat = readFileSync(join(import.meta.dir, '../../src/utils/tabula/minerva.ts'), 'utf8')
  const room = readFileSync(join(import.meta.dir, '../../src/utils/tabula/minervaRoom.ts'), 'utf8')
  t("§4 'refine without id' is dead", !chat.includes("'refine without id'"))
  t("§4 'refinement without a prompt handle' is dead", !room.includes("'refinement without a prompt handle'"))
}

console.log(failures === 0 ? 'MINERVA REFINE DEFAULTS: ALL PASS' : 'MINERVA REFINE DEFAULTS: RED')
process.exit(failures)
