#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-transcript-list-keys.ts — the transcript list's React-key
//  law (virtualListKeys): exact per index, unique among siblings, append-only
//  identity — and the stacked-copies disease it closes.
//
//  THE DISEASE (operator-sighted, driven on the real artifact with
//  the operator's own 327-record transcript): the virtual message list cached
//  its item keys append-only and re-derived them only when the list shrank
//  or its head row changed. The trailing turn receipt is always the LAST row
//  of the current turn, so every row that lands before it — the resume recap,
//  a settled reply, a tool group — took the receipt's key while the receipt
//  kept it too: two siblings, one key. Once the virtual window's start moved
//  (a long, scrolled transcript), React reconciled those siblings through
//  its keyed map, where the displaced fiber is neither reused nor deleted —
//  its host node stayed mounted as a zombie, one more copy per commit: the
//  same recap card, the same reply, painted two, three, four times, surviving
//  a resize (they are real tree nodes), the DOM growing until selection
//  crawled. The connector held every row exactly once throughout (the
//  MERCURY_CONNECTOR_TRACE seam: painted 308, display 1, list dupKeys 1).
//
//  Legs:
//   §1 the OLD law, re-stated as the control: the recap-before-receipt shape
//      yields a stale key and a duplicate sibling key (the disease, kept as
//      the reason the law exists);
//   §2 the NEW law on the same shape: exact keys, no duplicates;
//   §3 a pure append keeps the array's identity (the scroll hook's
//      incremental index rides it); an insertion, a replacement (the echo row
//      replaced by the file's row under a different uuid) and a shrink yield
//      a fresh array with exact keys;
//   §4 a colliding identity (two rows, one uuid) still renders under unique
//      sibling keys, deterministically;
//   §5 structural: the list derives its keys through the law (no append-only
//      loop remains), the connector's focus hook detaches only on a
//      re-point (the mid-hop landing pulse used to detach the very connector
//      being hopped into), and a resume recap replaces its predecessor on
//      the same connector (never a stack of cards per resume);
//   §6 the banner-collapse face (FN-016 R3's second face, verify-only): the
//      api-error banners collapse by REPLACING the last row at unchanged
//      length and head — under the old law the second attempt kept the
//      first's key, React reconciled in place and the mount-local countdown
//      carried over (pinned at "Retrying in 0 seconds…" once the delay was
//      no longer than the counter); under the law the replaced banner takes
//      its own uuid key in a fresh array — a fresh mount, a fresh countdown.
//
//  Run: bun scripts/ui/prove-transcript-list-keys.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { reconcileItemKeys } = await import(join(ROOT, 'src/components/virtualListKeys.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

type Row = { type: string; uuid: string }
const row = (type: string, uuid: string): Row => ({ type, uuid })
const keyOf = (m: Row): string => `${m.uuid}:conv`
const dupes = (keys: readonly string[]): string[] => {
  const seen = new Map<string, number>()
  for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
}
const exact = (keys: readonly string[], rows: readonly Row[]): number[] =>
  rows.map((m, i) => (keys[i] === keyOf(m) ? -1 : i)).filter(i => i >= 0)

// The operator's shape: settled rows, the last reply, the trailing receipt —
// then the resume recap lands BEFORE the receipt (a middle insertion).
const settled = [row('user', 'u1'), row('assistant', 'a1'), row('user', 'u2'), row('assistant', 'a2')]
const receipt = row('turn_receipt', 'u2-turn-receipt')
const recap = row('system', 'recap-1')
const before = [...settled, receipt]
const after = [...settled, recap, receipt]

// The OLD append-only law, kept as the control for the faces it broke.
const oldLaw = (prior: string[] | null, rows: Row[]): string[] => {
  const needsRebuild = prior === null || rows.length < prior.length || (rows.length > 0 && prior.length > 0 && prior[0] !== keyOf(rows[0]!))
  if (needsRebuild) return rows.map(keyOf)
  for (let i = prior.length; i < rows.length; i++) prior.push(keyOf(rows[i]!))
  return prior
}

section('§1 the old append-only law — the control (the disease re-stated)')
{
  const k1 = oldLaw(null, before)
  const k2 = oldLaw(k1, after)
  check('CONTROL: the old law leaves the recap under the receipt\'s key (stale index)', exact(k2, after).length === 1 && exact(k2, after)[0] === 4, JSON.stringify(exact(k2, after)))
  check('CONTROL: …and the receipt\'s key stands at two sibling indices (the zombie seed)', dupes(k2).length === 1 && dupes(k2)[0] === keyOf(receipt), JSON.stringify(dupes(k2)))
}

section('§2 the law on the operator\'s shape — exact and unique')
{
  const s1 = reconcileItemKeys(null, before, keyOf)
  check('the first derivation is exact', exact(s1.keys, before).length === 0)
  const s2 = reconcileItemKeys(s1, after, keyOf)
  check('the recap-before-receipt insertion re-derives the moved suffix: every index exact', exact(s2.keys, after).length === 0, JSON.stringify(s2.keys))
  check('no duplicate sibling keys after the insertion', dupes(s2.keys).length === 0, JSON.stringify(dupes(s2.keys)))
  check('an insertion yields a fresh array (the scroll hook re-indexes and drops dead heights)', s2.keys !== s1.keys)
  check('the state carries the rows it derived from', s2.rows === after)
}

section('§3 identity law — appends keep identity, moves and shrinks do not')
{
  const s1 = reconcileItemKeys(null, before, keyOf)
  const appended = [...before, row('user', 'u3')]
  const s2 = reconcileItemKeys(s1, appended, keyOf)
  check('a pure append keeps the array identity and appends one exact key', s2.keys === s1.keys && s2.keys.length === 6 && exact(s2.keys, appended).length === 0)
  check('a pure append returns the prior state object', s2 === s1)
  // the echo row replaced by the file's own row under a different uuid
  const echoed = [...before, row('user', 'send-echo-1')]
  const s3 = reconcileItemKeys(null, echoed, keyOf)
  const landed = [...before, row('user', '8a716ea4')]
  const s4 = reconcileItemKeys(s3, landed, keyOf)
  check('a replacement at the tail re-derives that key exactly', exact(s4.keys, landed).length === 0 && s4.keys[5] === '8a716ea4:conv', JSON.stringify(s4.keys))
  check('a replacement yields a fresh array', s4.keys !== s3.keys)
  const shrunk = before.slice(0, 3)
  const s5 = reconcileItemKeys(s4, shrunk, keyOf)
  check('a shrink truncates to exact keys in a fresh array', s5.keys.length === 3 && exact(s5.keys, shrunk).length === 0 && s5.keys !== s4.keys)
  // an unchanged row object never re-derives (the identity fast path): a
  // key function that throws on re-derivation proves it was not called
  let calls = 0
  const counting = (m: Row): string => {
    calls++
    return keyOf(m)
  }
  const c1 = reconcileItemKeys(null, before, counting)
  const c1calls = calls
  const c2 = reconcileItemKeys(c1, [...before, row('assistant', 'a3')], counting)
  check('unchanged row objects keep their keys without re-deriving (one call for the append)', calls === c1calls + 1 && c2.keys.length === 6, `calls ${calls - c1calls}`)
  // the key function changing (a new conversation id) rebuilds whole
  const other = (m: Row): string => `${m.uuid}:other`
  const c3 = reconcileItemKeys(c2, before, other)
  check('a new key function rebuilds every key', c3.keys.every((k, i) => k === other(before[i]!)) && c3.keyFn === other)
}

section('§4 sibling uniqueness under a colliding identity')
{
  const twins = [row('assistant', 'same'), row('assistant', 'same'), row('assistant', 'same')]
  const s1 = reconcileItemKeys(null, twins, keyOf)
  check('three rows with one uuid render under three distinct keys', new Set(s1.keys).size === 3, JSON.stringify(s1.keys))
  check('the suffixing is positional and deterministic', s1.keys[0] === 'same:conv' && s1.keys[1] === 'same:conv#2' && s1.keys[2] === 'same:conv#3', JSON.stringify(s1.keys))
  const s2 = reconcileItemKeys(s1, [...twins, row('assistant', 'same')], keyOf)
  check('an appended twin takes the next suffix', s2.keys[3] === 'same:conv#4' && new Set(s2.keys).size === 4, JSON.stringify(s2.keys))
}

section('§5 structural — the consumers ride the law')
{
  const list = readFileSync(join(ROOT, 'src/components/VirtualMessageList.tsx'), 'utf8')
  check('VirtualMessageList derives its keys through reconcileItemKeys', list.includes('reconcileItemKeys(keysStateRef.current, messages, itemKey)'))
  check('the append-only loop is gone', !list.includes('itemKeys.push(itemKey(messages[i]!, i))') && !list.includes('prior.keys[0] !== itemKey(messages[0]!, 0)'))
  const connector = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const hook = connector.slice(connector.indexOf('let lastFocusedForDetach'), connector.indexOf('\n})\n', connector.indexOf('let lastFocusedForDetach')))
  check('the focus hook detaches only on a re-point (a landing pulse without a slot change is a no-op)', hook.includes('if (focused === lastFocusedForDetach) return') && hook.includes('c.detach()'))
  const add = connector.slice(connector.indexOf('addDisplayRow(row: Message): void {'), connector.indexOf('transcriptFile(): string'))
  check('a resume recap replaces its predecessor on the same connector', add.includes("subtype === 'away_summary'") && add.includes('this.displayRows.filter('))
}

section('§6 the banner-collapse face (FN-016 R3, verify-only): every retry attempt mounts fresh')
{
  // reorderMessagesInUI collapses consecutive api-error banners by
  // REPLACING the last output element — same length, unchanged head, a
  // fresh object carrying the attempt's own uuid. Neither of the old law's
  // rebuild tests fired on that shape.
  const banner1 = row('system', 'api-error-attempt-1')
  const banner2 = row('system', 'api-error-attempt-2')
  const attempt1 = [...settled, banner1]
  const attempt2 = [...settled, banner2]
  const k1 = oldLaw(null, attempt1)
  const k2 = oldLaw(k1, attempt2)
  check('CONTROL: the old law kept the first attempt\'s key on the second (in-place reconcile — the frozen countdown)', k2[4] === keyOf(banner1), JSON.stringify(k2))
  const s1 = reconcileItemKeys(null, attempt1, keyOf)
  const s2 = reconcileItemKeys(s1, attempt2, keyOf)
  check('the replaced banner takes its own key — exact at every index', exact(s2.keys, attempt2).length === 0 && s2.keys[4] === keyOf(banner2), JSON.stringify(s2.keys))
  check('a fresh array: the swap is a re-mount, never an in-place reconcile', s2.keys !== s1.keys)
  check('no duplicate sibling keys', dupes(s2.keys).length === 0)
  // The producers and consumers this face rides — each pinned at its owner.
  const uiOrder = readFileSync(join(ROOT, 'src/utils/messages/uiOrder.ts'), 'utf8')
  check('uiOrder collapses consecutive banners by replacing the object', uiOrder.includes('result[result.length - 1] = message'))
  const messages = readFileSync(join(ROOT, 'src/components/Messages.tsx'), 'utf8')
  check('Messages keys rows by uuid (a replaced banner is a new key)', messages.includes('(message: RenderableMessage) => `${message.uuid}:${conversationId}`'))
  const banner = readFileSync(join(ROOT, 'src/components/messages/SystemAPIErrorMessage.tsx'), 'utf8')
  check('the countdown is mount-local state (a fresh mount restarts it)', banner.includes('const [countdownMs, setCountdownMs] = useState(0)'))
  const producer = readFileSync(join(ROOT, 'src/utils/messages/systemMessages.ts'), 'utf8')
  const creator = producer.slice(producer.indexOf('export function createSystemAPIErrorMessage'), producer.indexOf('compact-boundary predicates'))
  check('every attempt\'s banner carries a fresh uuid', creator.includes('uuid: randomUUID()'))
}

console.log(failures === 0 ? '\nprove-transcript-list-keys: ALL LAWS HOLD' : `\nprove-transcript-list-keys: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
