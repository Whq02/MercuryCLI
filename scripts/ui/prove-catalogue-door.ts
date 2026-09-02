#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-catalogue-door.ts — the /model catalogue door's PURE laws
//  (utils/model/catalogueDoor.ts + the footer's door states), no renderer:
//    1. closed: the composition is the listed rows, untouched;
//    2. open: the group's top-N rows and its door swap, at the group's first
//       model row, for ONE header line + the full list; other groups and
//       the group's other action rows (a stale-catalogue retry row) keep
//       their place; the header sentence is exact;
//    3. the filter: case-insensitive substring over id AND name, the
//       vendor's order kept among matches; blank = every row;
//    4. the focus rule: the first match, else the header (zero matches keep
//       the filter line focused); -1 when nothing is open;
//    5. a group with no door cannot open;
//    6. the footer: ↵ expand on a closed door · type to filter + ↵ switch /
//       ↵ collapse · esc collapse / esc clear while open · unchanged with no
//       door in play · the nav+exit floor survives a narrow panel.
//  The real screen is prove-catalogue-expand.ts (a PTY drive on the bundle).
// ============================================================================
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { composeCatalogueRows, filterCatalogueRows, catalogueDoorFocus, catalogueDoorHeader, catalogueDoorHeaderParts } = await import(
  '../../src/utils/model/catalogueDoor.ts'
)
const { modelPickerFooter } = await import('../../src/utils/model/modelPickerFooter.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 300) : ''}`)
}

type Row = { id: string; name: string; tag: string; ctx: string; group: string; action?: boolean; expand?: { group: string; family: string; total: number; open?: boolean } }
const OR = 'Mercury — OpenRouter models'
const HF = 'Mercury — Hugging Face models'
const AN = 'Mercury — Anthropic models'
const row = (id: string, name: string, group: string, extra: Partial<Row> = {}): Row => ({ id, name, tag: '', ctx: '', group, ...extra })
const DOOR = row('__mercury_openrouter_expand__', 'OpenRouter — 30 models live', OR, { tag: '↵ expand · 30 live · type to filter', action: true, expand: { group: OR, family: 'OpenRouter', total: 30 } })
const STALE = row('__mercury_openrouter_connect__', 'OpenRouter — catalogue stale (3m)', OR, { action: true })
const topN = Array.from({ length: 24 }, (_, i) => row(`openrouter/v/m-${i}`, `M ${i}`, OR))
const full = Array.from({ length: 30 }, (_, i) => (i === 27 ? row('openrouter/deepvendor/needle-model', 'Needle Model', OR) : row(`openrouter/v/m-${i}`, `M ${i}`, OR)))
const listed: Row[] = [row('default', 'Default', AN), row('claude-opus-5', 'Opus 5', AN), STALE, ...topN, DOOR, row('huggingface/o/x', 'X', HF)]
const ids = (rows: readonly Row[]): string => rows.map(r => r.id).join(',')

console.log('============================================================')
console.log(' the catalogue door — composition · filter · focus · footer')
console.log('============================================================')

console.log('[1] closed')
{
  const out = composeCatalogueRows(listed, null, '', full)
  check('the composition is the listed rows, in order, door included', ids(out) === ids(listed) && out.length === listed.length)
  check('no group open ⇒ the focus rule answers -1', catalogueDoorFocus(out, OR) === -1)
}

console.log('[2] open, empty filter')
{
  const out = composeCatalogueRows(listed, OR, '', full)
  check('the rows before the group and the group\'s other action row keep their place', out[0]?.id === 'default' && out[1]?.id === 'claude-opus-5' && out[2]?.id === STALE.id)
  const header = out[3]
  check('the header sits where the group\'s first model row sat, on the door\'s id, facet open', header?.id === DOOR.id && header?.expand?.open === true && header?.expand?.group === OR && header?.action === true)
  check('the header sentence is exact', header?.name === 'OpenRouter — 30 live · filter:  · esc collapse' && catalogueDoorHeader({ family: 'OpenRouter', total: 30 }, 'abc') === 'OpenRouter — 30 live · filter: abc · esc collapse')
  check('the header parts re-join to the sentence', ((): boolean => { const p = catalogueDoorHeaderParts({ family: 'Hugging Face', total: 131 }); return `${p.lead}xy${p.tail}` === 'Hugging Face — 131 live · filter: xy · esc collapse' })())
  check('the full list follows the header, every row, the vendor\'s order', out.slice(4, 34).map(r => r.id).join(',') === ids(full))
  check('the closed door is gone and the next group follows', !out.some(r => r.id === DOOR.id && r.expand?.open !== true) && out[34]?.id === 'huggingface/o/x' && out.length === 35)
  check('the focus rule lands on the first row of the open group', catalogueDoorFocus(out, OR) === 4)
}

console.log('[3] the filter')
{
  check('blank = every row (a copy)', filterCatalogueRows(full, '   ').length === 30 && filterCatalogueRows(full, '') !== full)
  check('a name match, case-insensitive, one deep row', ids(filterCatalogueRows(full, 'NEEDLE')) === 'openrouter/deepvendor/needle-model')
  // (row 27 is the needle, so m-27 is absent from the id matches)
  check('an id match, case-insensitive, vendor order kept', ids(filterCatalogueRows(full, 'V/M-2')) === ['openrouter/v/m-2', ...Array.from({ length: 10 }, (_, k) => `openrouter/v/m-2${k}`).filter(id => id !== 'openrouter/v/m-27')].join(','), ids(filterCatalogueRows(full, 'V/M-2')))
  check('a name substring keeps the order among matches', filterCatalogueRows(full, 'm 1').map(r => r.name).join(',') === ['M 1', ...Array.from({ length: 10 }, (_, k) => `M 1${k}`)].join(','))
  check('no match = empty', filterCatalogueRows(full, 'zzz-nothing').length === 0)
  const out = composeCatalogueRows(listed, OR, 'needle', full)
  check('the composition carries the filter into the header and narrows the group to the match', out[3]?.name === 'OpenRouter — 30 live · filter: needle · esc collapse' && out[4]?.id === 'openrouter/deepvendor/needle-model' && out[5]?.id === 'huggingface/o/x' && out.length === 6)
  check('the focus rule lands on the match', catalogueDoorFocus(out, OR) === 4)
}

console.log('[4] zero matches keep the filter line focused')
{
  const out = composeCatalogueRows(listed, OR, 'zzz', full)
  check('the group is the header alone, the next group follows', out[3]?.expand?.open === true && out[4]?.id === 'huggingface/o/x' && out.length === 5)
  check('the focus rule lands on the header', catalogueDoorFocus(out, OR) === 3)
}

console.log('[5] a group with no door cannot open')
{
  const out = composeCatalogueRows(listed, HF, 'x', full)
  check('the listed rows pass through untouched', ids(out) === ids(listed))
  check('no header ⇒ the focus rule answers -1', catalogueDoorFocus(out, HF) === -1)
}

console.log('[6] the footer')
{
  const base = { hasEffort: true, supports1m: false, gated: false }
  const plain = modelPickerFooter(base, 60)
  check('no door in play: unchanged (↵ switch … esc close)', plain === '↑↓ select · ←→ effort · ↵ switch · esc close', plain)
  const closed = modelPickerFooter({ ...base, door: { open: false } }, 60)
  check('a closed door: ↵ expand, esc close', closed === '↑↓ select · ←→ effort · ↵ expand · esc close', closed)
  const onRow = modelPickerFooter({ ...base, door: { open: true, onHeader: false, filtering: false } }, 80)
  check('open, on a row, no filter: type to filter · ↵ switch · esc collapse', onRow === '↑↓ select · ←→ effort · type to filter · ↵ switch · esc collapse', onRow)
  const onHeader = modelPickerFooter({ ...base, door: { open: true, onHeader: true, filtering: false } }, 80)
  check('open, on the header: ↵ collapse', onHeader === '↑↓ select · ←→ effort · type to filter · ↵ collapse · esc collapse', onHeader)
  const filtering = modelPickerFooter({ ...base, door: { open: true, onHeader: false, filtering: true } }, 80)
  check('open with a filter: esc clear', filtering.endsWith('esc clear') && filtering.includes('type to filter'), filtering)
  const sixty = modelPickerFooter({ ...base, door: { open: true, onHeader: false, filtering: false } }, 60)
  check('at 60 the effort segment sheds first (the filter hint and the action stay)', sixty === '↑↓ select · type to filter · ↵ switch · esc collapse', sixty)
  const narrow = modelPickerFooter({ ...base, door: { open: true, onHeader: false, filtering: true } }, 40)
  check('a narrow panel keeps the nav+exit floor and the filter hint sheds last (after effort and the action)', narrow === '↑↓ select · type to filter · esc clear' && narrow.length <= 40, narrow)
  const floor = modelPickerFooter({ ...base, door: { open: true, onHeader: false, filtering: true } }, 24)
  check('below everything the floor alone survives', floor === '↑↓ select · esc clear', floor)
}

console.log(failures === 0 ? '\n ✅ CATALOGUE DOOR — PURE LAWS GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
