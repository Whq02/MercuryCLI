#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-message-model-contract.ts —
// the message-model property layer (the characterization laws,
//  green on the OLD bodies
//  BEFORE the cut, then the gate for every change inside
//  src/utils/messages/.
//
//  This prover is deliberately the layer the R2 parity oracle
//  (scripts/messages/prove-messages-parity.ts, 20K-line goldens) CANNOT be:
//  seeded-adversarial inputs instead of a friendly fixture corpus, property
//  laws instead of snapshots, and REFERENCE-equality clauses the goldens'
//  deep-compare is structurally blind to (prompt-cache byte identity and
//  React memoization both ride on unchanged inputs flowing through BY
//  REFERENCE — see the backfill rule in src/run-core/model-lane.ts).
//
//    PAIR-POST         pairing postconditions over seeded adversarial corpora
//                      (exactly-once results, no dup uses, no orphans, role
//                      floor, reference preservation of untouched messages)
//    PAIR-IDEMPOTENT   repair(repair(x)) elementwise === repair(x)
//    PAIR-STRICT       strict mode throws IFF the non-strict pass repairs;
//                      the throw carries the structure map; no telemetry
//    PAIR-TELEMETRY    the repaired-pairing path fires logError
//                      exactly when output ≠ input (mocked analytics/log)
//    NORMALIZE-LATCH   derived-uuid uniqueness/determinism/latch monotonicity,
//                      block identity, imagePasteIds distribution,
//                      non-turn reference passthrough
//    SEAM              joinTextAtSeam \n-on-the-left + startsWith stability;
//                      hoistToolResults stable partition; mergeUserMessages
//                      meta-uuid table (all four combinations)
//    LOOKUPS-DIFF      buildMessageLookups vs the legacy O(n) scans and a
//                      naive re-derivation (resolved/errored/denied sets,
//                      sibling graph, hook counts, progress ORDER)
//    EMPTY-ALIAS       buildSubagentLookups aliases EMPTY_LOOKUPS planes
//                      (pinned as current truth) and the empties stay empty
//    DORMANT-GATE      mercury_chair_sermon / mercury_toolref_defer_j8m resolve
//                      false; the legacy string-only smoosh IS the live arm
//    FACTORY-QUIRKS    empty-'' vs empty-[] createUserMessage, synthetic
//                      assistant shape, breadcrumb uuid freshness
//    TEXT-TABLE        extractTag nesting/attributes, textForResubmit
//                      precedence, wrapCommandText origin rows,
//                      isNotEmptyMessage rows
//    ORDER             reorderMessagesInUI vs an independent naive oracle
//                      over seeded display corpora + reference preservation
//    SYSMSG            compact-boundary slice reference law, countToolCalls
//                      early exit, hasSuccessfulToolCall most-recent-wins
//    MAPPERS           the SDK↔internal mapping table (ledger addition —
//                      mappers.ts is NOT in the barrel, so the parity oracle
//                      never sees it): row mapping, compact-metadata
//                      round-trip, isSynthetic table, rate-limit field table
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-message-model-contract.ts
// ============================================================================
import { mock } from 'bun:test'

// ── module mocks (BEFORE any src import) ────────────────────────────────────
// The rig pattern (prove-runsurface-contract.ts): capture the real
// namespaces first, re-point the registry, THEN import the model under test.
// (The analytics facade mock is ABSENT with the telemetry estate —-P5.
// The pairing-repair observability law is now logError-only.)
const realLog = await import('../../src/utils/log.ts')

const loggedErrors: unknown[] = []
const logSnapshot = { ...realLog }

mock.module('../../src/utils/log.ts', () => ({
  ...logSnapshot,
  logError: (e: unknown) => {
    loggedErrors.push(e)
  },
}))

// ── src imports (AFTER the mocks) ───────────────────────────────────────────
const M = await import('../../src/utils/messages.ts')
const mergeMod = await import('../../src/utils/messages/merge.ts')
const rejection = await import('../../src/utils/messages/rejectionText.ts')
const mappers = await import('../../src/utils/messages/mappers.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
const featureGates = await import('../../src/services/analytics/featureGates.ts')

type AnyMsg = Record<string, any>
type Block = Record<string, any>

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(name: string): void {
  console.log(`── ${name}`)
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const pick = <T,>(rand: () => number, arr: T[]): T =>
  arr[Math.floor(rand() * arr.length)]!
const deepEq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

// ── deterministic message mint (through the real factories) ────────────────
// NOTE the counter rides the FIRST hex group: deriveUUID keys on
// parent.slice(0, 24), so fixture uuids sharing a 24-char prefix would sit in
// identity.ts's documented collision domain (pinned as a quirk below) and
// break the uniqueness law for fixture reasons, not body reasons.
let uuidCounter = 0
const nextUuid = (): string =>
  `${String(++uuidCounter).padStart(8, '0')}-0000-4000-8000-000000000000`
const PINNED_TS = '2026-01-01T00:00:00.000Z'

function mkUser(content: string | Block[], extra: AnyMsg = {}): AnyMsg {
  return {
    ...M.createUserMessage({
      content: content as never,
      uuid: nextUuid() as never,
      timestamp: PINNED_TS,
    }),
    ...extra,
  }
}
function mkAssistant(blocks: Block[] | string, msgId?: string): AnyMsg {
  const base = M.createAssistantMessage({ content: blocks as never }) as AnyMsg
  return {
    ...base,
    uuid: nextUuid(),
    timestamp: PINNED_TS,
    message: { ...base.message, id: msgId ?? `msg_${nextUuid().slice(-6)}` },
  }
}
const tu = (id: string): Block => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: { file_path: '/x' },
})
const tr = (id: string, text = `result for ${id}`, isError = false): Block => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [{ type: 'text', text }],
  is_error: isError,
})
const txt = (text: string): Block => ({ type: 'text', text })
const serverTu = (id: string): Block => ({
  type: 'server_tool_use',
  id,
  name: 'web_search',
  input: { query: 'q' },
})
const serverTr = (id: string): Block => ({
  type: 'web_search_tool_result',
  tool_use_id: id,
  content: [],
})

// ════════════════════════════════════════════════════════════════════════════
section('DORMANT-GATE — the owned gate table pins the smoosh family dead')
// FORK_GATE_TABLE = {} + dead env/config ladders ⇒ structurally false. This is
// the mechanical reachability proof behind the deletion of the
// universal-smoosh family (the T9 precedent).
check(
  'mercury_chair_sermon resolves false',
  featureGates.checkFeatureGate_CACHED_MAY_BE_STALE('mercury_chair_sermon') === false,
)
check(
  'mercury_toolref_defer_j8m resolves false',
  featureGates.checkFeatureGate_CACHED_MAY_BE_STALE('mercury_toolref_defer_j8m') === false,
)
{
  // The LEGACY arm is the live behavior: an array-content tool_result with a
  // trailing text sibling stays plain concatenation (no universal smoosh)…
  const a = [txt('lead'), tr('toolu_l1')]
  const b = [txt('sibling')]
  const out = M.mergeUserContentBlocks(a as never, b as never) as Block[]
  check(
    'legacy arm: array-content tool_result + text sibling = plain concat',
    out.length === 3 && out[0] === a[0] && out[1] === a[1] && out[2] === b[0],
  )
  // …while a STRING-content tool_result + all-text siblings smooshes (the
  // legacy string-only smoosh, the one live smoosh in this build).
  const a2 = [{ ...tr('toolu_l2'), content: 'out' }]
  const out2 = M.mergeUserContentBlocks(a2 as never, [txt('x'), txt('y')] as never) as Block[]
  check(
    'legacy arm: string-content tool_result + all-text siblings smooshes',
    out2.length === 1 && out2[0]!.content === 'out\n\nx\n\ny',
    JSON.stringify(out2),
  )
  // Mixed (non-text) siblings refuse the legacy smoosh — concat.
  const out3 = M.mergeUserContentBlocks(
    a2 as never,
    [txt('x'), { type: 'image', source: { type: 'base64', data: '', media_type: 'image/png' } }] as never,
  ) as Block[]
  check('legacy arm: non-text sibling ⇒ concat', out3.length === 3)
}

// ════════════════════════════════════════════════════════════════════════════
section('SEAM — joinTextAtSeam / hoistToolResults / meta-uuid algebra')
{
  const j = mergeMod.joinTextAtSeam
  // Text-text seam: exactly one \n appended to the LEFT block; the right
  // block untouched by reference; startsWith of every block unchanged.
  const a = [txt('<system-reminder>\nnote\n</system-reminder>'), txt('left tail')]
  const b = [txt('right head'), tr('toolu_s1')]
  const out = j(a as never, b as never) as Block[]
  check('seam: length preserved', out.length === 4)
  check('seam: untouched left blocks by reference', out[0] === a[0])
  check('seam: left tail gains exactly one \\n', out[1]!.text === 'left tail\n')
  check('seam: right blocks by reference', out[2] === b[0] && out[3] === b[1])
  check(
    'seam: startsWith(<system-reminder>) stable across the seam',
    (out[0]!.text as string).startsWith('<system-reminder>') &&
      !(out[1]!.text as string).startsWith('<system-reminder>') &&
      !(out[2]!.text as string).startsWith('<system-reminder>'),
  )
  // Non-text seam: pure concat, all references preserved.
  const a2 = [tr('toolu_s2')]
  const out2 = j(a2 as never, b as never) as Block[]
  check('seam: non-text seam is pure concat', out2[0] === a2[0] && out2[1] === b[0])
  // Empty sides.
  check('seam: empty right returns left content', (j(a as never, [] as never) as Block[]).length === 2)
  check('seam: empty left returns right content', (j([] as never, b as never) as Block[]).length === 2)

  const h = mergeMod.hoistToolResults
  const rand = lcg(0x5eed1)
  let hoistViolations = 0
  for (let iter = 0; iter < 50; iter++) {
    const blocks: Block[] = []
    const n = 1 + Math.floor(rand() * 8)
    for (let i = 0; i < n; i++) {
      blocks.push(rand() < 0.4 ? tr(`toolu_h${iter}_${i}`) : txt(`t${iter}_${i}`))
    }
    const out3 = h(blocks as never) as Block[]
    const results = blocks.filter(x => x.type === 'tool_result')
    const others = blocks.filter(x => x.type !== 'tool_result')
    const expected = [...results, ...others]
    if (out3.length !== expected.length || out3.some((x, i) => x !== expected[i])) {
      hoistViolations++
    }
  }
  check('hoist: stable partition, references preserved (50 random)', hoistViolations === 0, `${hoistViolations} violations`)

  // mergeUserMessages meta-uuid selection: a.isMeta ? b.uuid : a.uuid.
  for (const [aMeta, bMeta] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const ma = mkUser('a-text', aMeta ? { isMeta: true } : {})
    const mb = mkUser('b-text', bMeta ? { isMeta: true } : {})
    const merged = M.mergeUserMessages(ma as never, mb as never) as AnyMsg
    const want = aMeta ? mb.uuid : ma.uuid
    check(
      `mergeUserMessages uuid: aMeta=${aMeta} bMeta=${bMeta} keeps ${aMeta ? 'b' : 'a'}.uuid`,
      merged.uuid === want,
    )
  }
}

// ════════════════════════════════════════════════════════════════════════════
section('NORMALIZE-LATCH — derived-uuid law over random block mixes')
{
  const rand = lcg(0x17e5)
  const image = (): Block => ({
    type: 'image',
    source: { type: 'base64', data: 'aGk=', media_type: 'image/png' },
  })
  let latchViolations = 0
  let uniqueViolations = 0
  let blockIdViolations = 0
  let passthroughViolations = 0
  let determinismViolations = 0
  for (let iter = 0; iter < 40; iter++) {
    const msgs: AnyMsg[] = []
    const n = 2 + Math.floor(rand() * 10)
    for (let i = 0; i < n; i++) {
      const roll = rand()
      if (roll < 0.35) {
        // user: string | 1..3 blocks
        const r2 = rand()
        if (r2 < 0.34) msgs.push(mkUser(`plain ${iter}-${i}`))
        else {
          const blocks: Block[] = []
          const k = 1 + Math.floor(rand() * 3)
          for (let bIdx = 0; bIdx < k; bIdx++) {
            blocks.push(rand() < 0.4 ? image() : txt(`u${iter}-${i}-${bIdx}`))
          }
          msgs.push(
            mkUser(blocks, {
              imagePasteIds: blocks.some(x => x.type === 'image') ? [7, 9, 11] : undefined,
            }),
          )
        }
      } else if (roll < 0.7) {
        const blocks: Block[] = []
        const k = 1 + Math.floor(rand() * 3)
        for (let bIdx = 0; bIdx < k; bIdx++) blocks.push(txt(`a${iter}-${i}-${bIdx}`))
        msgs.push(mkAssistant(blocks))
      } else if (roll < 0.8) {
        msgs.push({
          type: 'progress',
          uuid: nextUuid(),
          timestamp: PINNED_TS,
          data: { type: 'bash_progress' },
          toolUseID: 'toolu_p',
          parentToolUseID: 'toolu_p',
        })
      } else if (roll < 0.9) {
        msgs.push({
          type: 'attachment',
          uuid: nextUuid(),
          timestamp: PINNED_TS,
          attachment: { type: 'diagnostics', files: [] },
        })
      } else {
        msgs.push(M.createSystemMessage(`sys ${iter}-${i}`, 'info') as AnyMsg)
      }
    }

    const out = M.normalizeMessages(msgs as never) as AnyMsg[]
    const out2 = M.normalizeMessages(msgs as never) as AnyMsg[]

    // Determinism: identical uuid sequences run-to-run.
    if (out.map(m => m.uuid).join(',') !== out2.map(m => m.uuid).join(',')) determinismViolations++

    // Global uuid uniqueness.
    const uuids = out.map(m => m.uuid)
    if (new Set(uuids).size !== uuids.length) uniqueViolations++

    // Latch monotonicity + block identity + passthrough.
    let latched = false
    let outIdx = 0
    for (const msg of msgs) {
      if (msg.type === 'progress' || msg.type === 'attachment' || msg.type === 'system') {
        if (out[outIdx] !== msg) passthroughViolations++
        outIdx++
        continue
      }
      const contentIsString = typeof msg.message.content === 'string'
      const blocks: Block[] = contentIsString
        ? [msg.message.content]
        : msg.message.content
      if (!contentIsString && blocks.length > 1) latched = true
      for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
        const o = out[outIdx + bIdx]!
        const expectDerived = latched
        const gotUuid = o.uuid as string
        if (expectDerived) {
          const want = M.deriveUUID(msg.uuid as never, contentIsString ? 0 : bIdx)
          if (gotUuid !== want) latchViolations++
        } else if (gotUuid !== msg.uuid) {
          latchViolations++
        }
        // Block identity: split messages carry the ORIGINAL block objects.
        if (!contentIsString && o.message.content[0] !== blocks[bIdx]) blockIdViolations++
      }
      outIdx += blocks.length
    }
  }
  check('normalize: latch monotonicity + derived-uuid law (40 random)', latchViolations === 0, `${latchViolations}`)
  check('normalize: global uuid uniqueness', uniqueViolations === 0, `${uniqueViolations}`)
  check('normalize: deterministic uuid sequence', determinismViolations === 0, `${determinismViolations}`)
  check('normalize: split blocks by reference', blockIdViolations === 0, `${blockIdViolations}`)
  check('normalize: progress/attachment/system reference passthrough', passthroughViolations === 0, `${passthroughViolations}`)

  // THE COLLISION-FREE LAW (identity.ts): the derived tail hashes the WHOLE
  // parent identity + index, so parents sharing a 24-char prefix derive
  // DISTINCT rows — a bare-index tail collided with any sibling uuid that
  // differed only in the node segment (sequential-uuid transcripts:
  // fixtures, imports), and duplicate React keys in one transcript list
  // corrupted reconciliation (the /clear zombie row). The 24-char parent
  // prefix itself is preserved (divider/settlement prefix recovery).
  check(
    'deriveUUID: parents sharing a 24-char prefix derive DISTINCT rows',
    M.deriveUUID('99999999-aaaa-4000-8000-000000000001' as never, 0) !==
      M.deriveUUID('99999999-aaaa-4000-8000-fffffffffff2' as never, 0),
  )
  check(
    'deriveUUID: a derived row can never equal a sibling parent uuid (the duplicate-key class)',
    M.deriveUUID('00000000-0000-4000-8000-000000000002' as never, 1) !==
      ('00000000-0000-4000-8000-000000000001' as string),
  )
  check(
    'deriveUUID: keeps the parent 24-char prefix (recovery law)',
    M.deriveUUID('99999999-aaaa-4000-8000-000000000001' as never, 3).startsWith('99999999-aaaa-4000-8000-'),
  )

  // imagePasteIds distribution: one per image block, in image order.
  const withImages = mkUser([image(), txt('t'), image()], { imagePasteIds: [7, 9] })
  const outImgs = M.normalizeMessages([withImages] as never) as AnyMsg[]
  check(
    'normalize: imagePasteIds distribute one-per-image in order',
    deepEq(outImgs[0]!.imagePasteIds, [7]) &&
      outImgs[1]!.imagePasteIds === undefined &&
      deepEq(outImgs[2]!.imagePasteIds, [9]),
    JSON.stringify(outImgs.map(m => m.imagePasteIds)),
  )
}

// ════════════════════════════════════════════════════════════════════════════
section('PAIR — adversarial corpus generator + postcondition oracle')

/** Seeded adversarial conversation: tool turns with injected dup/orphan/
 *  missing/server-side anomalies. Returns turn messages only (the pairing
 *  input contract). */
function genPairingConversation(rand: () => number, iter: number): AnyMsg[] {
  const msgs: AnyMsg[] = []
  let toolSeq = 0
  const mintedIds: string[] = []
  const nTurns = 1 + Math.floor(rand() * 6)

  // Anomaly: conversation starts with an orphaned tool_result user.
  if (rand() < 0.2) {
    msgs.push(mkUser([tr(`toolu_pre${iter}`), txt('resumed mid-turn')]))
  }
  if (rand() < 0.3) msgs.push(mkUser(`prompt ${iter}`))

  for (let t = 0; t < nTurns; t++) {
    const useIds: string[] = []
    const blocks: Block[] = []
    if (rand() < 0.5) blocks.push(txt(`thinking about turn ${t}`))
    const nUses = Math.floor(rand() * 3)
    for (let u = 0; u < nUses; u++) {
      const id = `toolu_${iter}_${toolSeq++}`
      useIds.push(id)
      mintedIds.push(id)
      blocks.push(tu(id))
    }
    // Anomaly: cross-message duplicate tool_use (re-mint an earlier id).
    if (rand() < 0.15 && mintedIds.length > 0) {
      blocks.push(tu(pick(rand, mintedIds)))
    }
    // Anomaly: server-side use, sometimes orphaned (no same-message result).
    if (rand() < 0.2) {
      const sid = `srvtoolu_${iter}_${toolSeq++}`
      blocks.push(serverTu(sid))
      if (rand() < 0.5) blocks.push(serverTr(sid))
    }
    if (blocks.length === 0) blocks.push(txt(`plain ${t}`))
    msgs.push(mkAssistant(blocks))

    // The user reply: subset/superset/dup of the expected results.
    const roll = rand()
    if (roll < 0.15) {
      // Missing user entirely (next turn is another assistant / end).
      continue
    }
    const resBlocks: Block[] = []
    for (const id of useIds) {
      if (rand() < 0.75) resBlocks.push(tr(id, `result ${id}`, rand() < 0.3))
      if (rand() < 0.1) resBlocks.push(tr(id, `dup ${id}`)) // duplicate result
    }
    if (rand() < 0.15) resBlocks.push(tr(`toolu_orphan_${iter}_${toolSeq++}`)) // orphan
    if (rand() < 0.3) resBlocks.push(txt(`user says ${t}`))
    if (resBlocks.length === 0) resBlocks.push(txt(`ack ${t}`))
    msgs.push(mkUser(resBlocks))
  }
  if (rand() < 0.3) msgs.push(mkUser(`closing ${iter}`))
  return msgs
}

/** Postcondition oracle for ensureToolResultPairing output. Returns a list of
 *  violation strings (empty = lawful). */
function pairPostViolations(input: AnyMsg[], output: AnyMsg[]): string[] {
  const v: string[] = []
  const seenUses = new Set<string>()

  for (let i = 0; i < output.length; i++) {
    const msg = output[i]!
    const content = msg.message?.content
    if (Array.isArray(content) && content.length === 0) {
      v.push(`[${i}] empty content array`)
    }
    if (msg.type === 'assistant') {
      const uses = (content as Block[]).filter(b => b.type === 'tool_use')
      const serverUses = (content as Block[]).filter(
        b => b.type === 'server_tool_use' || b.type === 'mcp_tool_use',
      )
      const sameMsgResultIds = new Set(
        (content as Block[])
          .filter(b => typeof b.tool_use_id === 'string')
          .map(b => b.tool_use_id as string),
      )
      for (const su of serverUses) {
        if (!sameMsgResultIds.has(su.id)) v.push(`[${i}] orphaned server use ${su.id}`)
      }
      for (const u of uses) {
        if (seenUses.has(u.id)) v.push(`[${i}] duplicate tool_use ${u.id}`)
        seenUses.add(u.id)
      }
      if (uses.length > 0) {
        const next = output[i + 1]
        if (!next || next.type !== 'user') {
          v.push(`[${i}] tool_use assistant not followed by user`)
          continue
        }
        const nextContent = Array.isArray(next.message.content)
          ? (next.message.content as Block[])
          : []
        const resultCounts = new Map<string, number>()
        for (const b of nextContent) {
          if (b.type === 'tool_result') {
            resultCounts.set(b.tool_use_id, (resultCounts.get(b.tool_use_id) ?? 0) + 1)
          }
        }
        for (const u of uses) {
          if ((resultCounts.get(u.id) ?? 0) !== 1) {
            v.push(`[${i}] use ${u.id} has ${resultCounts.get(u.id) ?? 0} results in next user`)
          }
        }
        for (const [rid, n] of resultCounts) {
          if (!uses.some(u => u.id === rid)) v.push(`[${i + 1}] orphaned result ${rid}`)
          if (n > 1) v.push(`[${i + 1}] duplicate result ${rid}`)
        }
      }
    }
    if (msg.type === 'user' && Array.isArray(content)) {
      const hasResults = (content as Block[]).some(b => b.type === 'tool_result')
      if (hasResults) {
        const prev = output[i - 1]
        if (!prev || prev.type !== 'assistant') {
          v.push(`[${i}] tool_result user without preceding assistant`)
        }
      }
    }
  }

  // Role floor: a user-first input stays user-first.
  if (input.length > 0 && input[0]!.type === 'user' && output.length > 0) {
    if (output[0]!.type !== 'user') v.push('user-first input became non-user-first')
  }

  // Reference preservation: any output message deep-equal to the same-uuid
  // input message must BE that input message (cloning-without-change is the
  // regression class the goldens cannot see).
  const inputByUuid = new Map(input.map(m => [m.uuid as string, m]))
  for (let i = 0; i < output.length; i++) {
    const o = output[i]!
    const src = inputByUuid.get(o.uuid as string)
    if (src && src !== o && deepEq(src, o)) {
      v.push(`[${i}] cloned-without-change (uuid ${o.uuid})`)
    }
  }
  return v
}

const elementwiseSame = (a: AnyMsg[], b: AnyMsg[]): boolean =>
  a.length === b.length && a.every((m, i) => m === b[i])

{
  const rand = lcg(0xa11ce)
  const N = 150
  let postViolations = 0
  let idempotentViolations = 0
  let noRepairIdentityViolations = 0
  let telemetryViolations = 0
  let repairedCount = 0
  const violationSamples: string[] = []

  for (let iter = 0; iter < N; iter++) {
    const input = genPairingConversation(rand, iter)

    loggedErrors.length = 0
    const out = M.ensureToolResultPairing(input as never) as AnyMsg[]
    const repaired = !elementwiseSame(input, out)
    if (repaired) repairedCount++

    // PAIR-OBSERVABILITY: logError fires IFF output ≠ input (the telemetry
    // event arm was retired with the estate —-P5).
    const errLogged = loggedErrors.length
    if (repaired && errLogged !== 1) telemetryViolations++
    if (!repaired && errLogged !== 0) telemetryViolations++

    // PAIR-POST.
    const v = pairPostViolations(input, out)
    if (v.length > 0) {
      postViolations++
      if (violationSamples.length < 3) violationSamples.push(`iter ${iter}: ${v[0]}`)
    }

    // No-repair ⇒ elementwise identity (reference preservation, total form).
    if (!repaired) {
      // (definitionally true given elementwiseSame — kept as the named law)
    } else {
      // Unchanged messages inside a repaired conversation stay by reference:
      // covered by the cloned-without-change clause in pairPostViolations.
    }

    // PAIR-IDEMPOTENT: repair(repair(x)) elementwise === repair(x).
    loggedErrors.length = 0
    const out2 = M.ensureToolResultPairing(out as never) as AnyMsg[]
    if (!elementwiseSame(out, out2)) idempotentViolations++
    if (loggedErrors.length !== 0) idempotentViolations++ // fixpoint logs nothing
    void noRepairIdentityViolations
  }

  check(`PAIR-POST: postconditions over ${N} adversarial conversations`, postViolations === 0,
    `${postViolations} conv(s) violated; ${violationSamples.join(' | ')}`)
  check('PAIR-IDEMPOTENT: repair is a one-pass fixpoint (elementwise ===, silent)', idempotentViolations === 0,
    `${idempotentViolations}`)
  check('PAIR-TELEMETRY: event+logError fire iff repaired', telemetryViolations === 0, `${telemetryViolations}`)
  check('generator exercises the repair path', repairedCount > N / 4, `${repairedCount}/${N} repaired`)
  check('generator exercises the clean path', repairedCount < N, `${repairedCount}/${N} repaired`)
}

{
  // PAIR-STRICT over a fresh corpus: throws IFF the non-strict pass repairs;
  // the throw carries the structure map; strict throws emit NO telemetry.
  const rand = lcg(0x57121c7)
  const N = 80
  let strictViolations = 0
  let mapMissing = 0
  let telemetryLeaks = 0
  for (let iter = 0; iter < N; iter++) {
    const input = genPairingConversation(rand, 1000 + iter)
    const out = M.ensureToolResultPairing(input as never) as AnyMsg[]
    const wouldRepair = !elementwiseSame(input, out)

    bootstrap.setStrictToolResultPairing(true)
    loggedErrors.length = 0
    let threw: Error | null = null
    try {
      M.ensureToolResultPairing(input as never)
    } catch (e) {
      threw = e as Error
    } finally {
      bootstrap.setStrictToolResultPairing(false)
    }
    if (wouldRepair !== (threw !== null)) strictViolations++
    if (threw && !threw.message.includes('Message structure:')) mapMissing++
    if (threw && loggedErrors.length > 0) telemetryLeaks++
  }
  check(`PAIR-STRICT: throws iff non-strict repairs (${N} conversations)`, strictViolations === 0, `${strictViolations}`)
  check('PAIR-STRICT: the throw carries the structure map', mapMissing === 0, `${mapMissing}`)
  check('PAIR-STRICT: a strict throw emits no telemetry', telemetryLeaks === 0, `${telemetryLeaks}`)
}

{
  // Directed pairing cases (the incident classes) + characterized quirks.
  // compat-1212: cross-message duplicate tool_use strips the LATER re-mint.
  const dupId = 'toolu_cc1212'
  const inputDup = [
    mkAssistant([tu(dupId)]),
    mkUser([tr(dupId)]),
    mkAssistant([tu(dupId), txt('re-pushed')]),
    mkUser([tr(dupId)]),
  ]
  const outDup = M.ensureToolResultPairing(inputDup as never) as AnyMsg[]
  const allUses = outDup.flatMap(m =>
    m.type === 'assistant' ? (m.message.content as Block[]).filter(b => b.type === 'tool_use') : [],
  )
  check('compat-1212: cross-message duplicate use stripped', allUses.length === 1)
  check('compat-1212: first pairing untouched by reference', outDup[0] === inputDup[0] && outDup[1] === inputDup[1])

  // Emptied assistant gets the interrupted placeholder.
  const outEmptied = M.ensureToolResultPairing([
    mkAssistant([tu('toolu_e1')]),
    mkUser([tr('toolu_e1')]),
    mkAssistant([tu('toolu_e1')]),
    mkUser([txt('tail')]),
  ] as never) as AnyMsg[]
  const emptied = outEmptied[2]!
  check(
    'emptied assistant → [Tool use interrupted]',
    (emptied.message.content as Block[]).length === 1 &&
      (emptied.message.content as Block[])[0]!.text === '[Tool use interrupted]',
  )

  // Orphaned FIRST user keeps the resume placeholder (payload starts user).
  const outFirst = M.ensureToolResultPairing([
    mkUser([tr('toolu_f1')]),
    mkAssistant('hello'),
  ] as never) as AnyMsg[]
  check(
    'orphaned first user → resume placeholder, still user-first',
    outFirst[0]!.type === 'user' &&
      (outFirst[0]!.message.content as Block[])[0]!.text ===
        '[Orphaned tool result removed due to conversation resume]',
  )

  // Everything-stripped NEXT user becomes the NO_CONTENT meta user.
  const outMeta = M.ensureToolResultPairing([
    mkAssistant([txt('no tools')]),
    mkUser([tr('toolu_m1')]),
  ] as never) as AnyMsg[]
  check(
    'everything-stripped next user → NO_CONTENT meta user (role alternation)',
    outMeta.length === 2 &&
      outMeta[1]!.type === 'user' &&
      outMeta[1]!.isMeta === true &&
      typeof outMeta[1]!.message.content === 'string',
    JSON.stringify(outMeta[1]?.message?.content),
  )

  // Missing result with NO next user ⇒ synthetic meta user appended.
  const outSynth = M.ensureToolResultPairing([mkAssistant([tu('toolu_s9')])] as never) as AnyMsg[]
  check(
    'tail tool_use → synthetic is_error result appended',
    outSynth.length === 2 &&
      outSynth[1]!.type === 'user' &&
      (outSynth[1]!.message.content as Block[])[0]!.type === 'tool_result' &&
      (outSynth[1]!.message.content as Block[])[0]!.is_error === true &&
      (outSynth[1]!.message.content as Block[])[0]!.content ===
        rejection.SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  )

  // CHARACTERIZED QUIRK (pairing.ts:146-161): an assistant whose content was
  // ALREADY an empty array passes through BY REFERENCE — the '[Tool use
  // interrupted]' fill only applies when stripping emptied it, because the
  // push gates on assistantContentChanged. Do not "fix" silently.
  const emptyAssistant = mkAssistant([txt('x')])
  emptyAssistant.message = { ...emptyAssistant.message, content: [] }
  loggedErrors.length = 0
  const outEmptyIn = M.ensureToolResultPairing([emptyAssistant, mkUser('hi')] as never) as AnyMsg[]
  check(
    'QUIRK: pre-existing empty assistant passes through unrepaired by reference',
    outEmptyIn[0] === emptyAssistant && loggedErrors.length === 0,
  )
}

// ════════════════════════════════════════════════════════════════════════════
section('LOOKUPS-DIFF — lookups vs legacy scans vs naive re-derivation')
{
  const rand = lcg(0xdeadbe)
  const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const

  function genLookupConversation(iter: number): { raw: AnyMsg[] } {
    const raw: AnyMsg[] = []
    let seq = 0
    const nTurns = 1 + Math.floor(rand() * 5)
    raw.push(mkUser(`prompt ${iter}`))
    for (let t = 0; t < nTurns; t++) {
      const shareId = rand() < 0.3
      const msgId = `msg_lk_${iter}_${shareId ? 'shared' : t}`
      const blocks: Block[] = []
      const useIds: string[] = []
      const nUses = Math.floor(rand() * 3)
      for (let u = 0; u < nUses; u++) {
        const id = `toolu_lk_${iter}_${seq++}`
        useIds.push(id)
        blocks.push(tu(id))
      }
      if (rand() < 0.3) {
        const sid = `srvtoolu_lk_${iter}_${seq++}`
        blocks.push(serverTu(sid))
        if (rand() < 0.4) blocks.push(serverTr(sid))
      }
      if (blocks.length === 0) blocks.push(txt(`turn ${t}`))
      raw.push(mkAssistant(blocks, msgId))

      // hook progress + attachments + results
      for (const id of useIds) {
        if (rand() < 0.5) {
          for (const ev of HOOK_EVENTS) {
            if (rand() < 0.5) continue
            const nProg = 1 + Math.floor(rand() * 2)
            for (let p = 0; p < nProg; p++) {
              raw.push({
                type: 'progress',
                uuid: nextUuid(),
                timestamp: PINNED_TS,
                data: { type: 'hook_progress', hookEvent: ev, hookName: `hook${p}` },
                toolUseID: id,
                parentToolUseID: id,
              })
            }
            const nRes = Math.floor(rand() * 3)
            for (let r = 0; r < nRes; r++) {
              raw.push({
                type: 'attachment',
                uuid: nextUuid(),
                timestamp: PINNED_TS,
                attachment: {
                  // Two attachment rows for the SAME hook name must dedup.
                  type: r === 1 && rand() < 0.5 ? 'hook_additional_context' : 'hook_success',
                  toolUseID: id,
                  hookEvent: ev,
                  hookName: `hook${Math.floor(rand() * 2)}`,
                },
              })
            }
          }
        }
        if (rand() < 0.2) {
          raw.push({
            type: 'progress',
            uuid: nextUuid(),
            timestamp: PINNED_TS,
            data: { type: 'bash_progress' },
            toolUseID: id,
            parentToolUseID: id,
          })
        }
        if (rand() < 0.85) {
          const isError = rand() < 0.4
          const denial = isError && rand() < 0.5
          raw.push(
            mkUser([tr(id, denial ? rejection.REJECT_MESSAGE : `ok ${id}`, isError)], {
              toolUseResult: { ok: !isError },
            }),
          )
        }
      }
    }
    // Sometimes end on an assistant with an orphaned server use (the
    // still-streaming exemption).
    if (rand() < 0.4) {
      raw.push(mkAssistant([serverTu(`srvtoolu_lk_${iter}_tail`)], `msg_lk_${iter}_tail`))
    }
    return { raw }
  }

  let siblingViolations = 0
  let hookViolations = 0
  let setViolations = 0
  let orderViolations = 0
  let orphanViolations = 0
  const N = 60
  for (let iter = 0; iter < N; iter++) {
    const { raw } = genLookupConversation(iter)
    const normalized = M.normalizeMessages(raw as never) as AnyMsg[]
    const lookups = M.buildMessageLookups(normalized as never, raw as never)

    // Differential 1: sibling sets, lookup vs legacy scan, per message.
    for (const nm of normalized) {
      const viaLookup = M.getSiblingToolUseIDsFromLookup(nm as never, lookups as never)
      const viaScan = M.getSiblingToolUseIDs(nm as never, raw as never)
      if (
        viaLookup.size !== viaScan.size ||
        [...viaScan].some(id => !viaLookup.has(id))
      ) {
        siblingViolations++
      }
    }

    // Differential 2: hook resolution, lookup vs legacy scan, per (id, event).
    const allIds = new Set<string>()
    for (const m of raw) {
      if (m.type !== 'assistant') continue
      for (const b of m.message.content as Block[]) if (b.type === 'tool_use') allIds.add(b.id)
    }
    for (const id of allIds) {
      for (const ev of HOOK_EVENTS) {
        const a = M.hasUnresolvedHooksFromLookup(id, ev as never, lookups as never)
        const b = M.hasUnresolvedHooks(normalized as never, id, ev as never)
        if (a !== b) hookViolations++
      }
    }

    // Differential 3: resolved/errored/denied sets vs a naive re-derivation.
    const nResolved = new Set<string>()
    const nErrored = new Set<string>()
    const nDenied = new Set<string>()
    for (const nm of normalized) {
      if (nm.type === 'user') {
        for (const b of nm.message.content as Block[]) {
          if (b.type !== 'tool_result') continue
          nResolved.add(b.tool_use_id)
          if (b.is_error) {
            nErrored.add(b.tool_use_id)
            const text = Array.isArray(b.content)
              ? (b.content as Block[])
                  .map(c => (c.type === 'text' ? String(c.text ?? '') : ''))
                  .join('\n')
              : typeof b.content === 'string'
                ? b.content
                : ''
            if (rejection.isDenialResultText(text)) nDenied.add(b.tool_use_id)
          }
        }
      }
      if (nm.type === 'assistant') {
        for (const b of nm.message.content as Block[]) {
          if (typeof b.tool_use_id === 'string') nResolved.add(b.tool_use_id)
        }
      }
    }
    // Orphaned server uses of NON-last (raw) assistant ids force-resolve+error.
    const lastRaw = raw.at(-1)
    const exemptId = lastRaw?.type === 'assistant' ? lastRaw.message.id : undefined
    for (const nm of normalized) {
      if (nm.type !== 'assistant' || nm.message.id === exemptId) continue
      for (const b of nm.message.content as Block[]) {
        if (
          (b.type === 'server_tool_use' || b.type === 'mcp_tool_use') &&
          !nResolved.has(b.id)
        ) {
          nResolved.add(b.id)
          nErrored.add(b.id)
        }
      }
    }
    const setEq = (a: Set<string>, b: ReadonlySet<string>): boolean =>
      a.size === b.size && [...a].every(x => b.has(x))
    if (
      !setEq(nResolved, lookups.resolvedToolUseIDs) ||
      !setEq(nErrored, lookups.erroredToolUseIDs) ||
      !setEq(nDenied, lookups.deniedToolUseIDs)
    ) {
      setViolations++
    }

    // The last-assistant exemption itself: tail orphaned server uses are
    // neither resolved nor errored.
    if (lastRaw?.type === 'assistant') {
      for (const b of lastRaw.message.content as Block[]) {
        if (b.type === 'server_tool_use') {
          const sameMsgResults = new Set(
            (lastRaw.message.content as Block[])
              .filter(x => typeof x.tool_use_id === 'string')
              .map(x => x.tool_use_id),
          )
          if (!sameMsgResults.has(b.id)) {
            if (lookups.resolvedToolUseIDs.has(b.id) || lookups.erroredToolUseIDs.has(b.id)) {
              orphanViolations++
            }
          }
        }
      }
    }

    // Progress ORDER: per id, lookup arrays are the input-order progress
    // messages BY REFERENCE (renderers depend on push order; the goldens
    // sort maps and cannot see this).
    const progressById = new Map<string, AnyMsg[]>()
    for (const nm of normalized) {
      if (nm.type === 'progress') {
        const arr = progressById.get(nm.parentToolUseID) ?? []
        arr.push(nm)
        progressById.set(nm.parentToolUseID, arr)
      }
    }
    for (const [id, arr] of progressById) {
      const got = lookups.progressMessagesByToolUseID.get(id) ?? []
      if (got.length !== arr.length || got.some((m: AnyMsg, i: number) => m !== arr[i])) {
        orderViolations++
      }
    }
    if ([...lookups.progressMessagesByToolUseID.keys()].some(id => !progressById.has(id))) {
      orderViolations++
    }
  }
  check(`LOOKUPS-DIFF: sibling sets lookup ≡ legacy scan (${N} conversations)`, siblingViolations === 0, `${siblingViolations}`)
  check('LOOKUPS-DIFF: hook resolution lookup ≡ legacy scan', hookViolations === 0, `${hookViolations}`)
  check('LOOKUPS-DIFF: resolved/errored/denied ≡ naive re-derivation', setViolations === 0, `${setViolations}`)
  check('LOOKUPS-DIFF: last-assistant streaming exemption holds', orphanViolations === 0, `${orphanViolations}`)
  check('LOOKUPS-DIFF: progress arrays preserve input order by reference', orderViolations === 0, `${orderViolations}`)
}

// ════════════════════════════════════════════════════════════════════════════
section('EMPTY-ALIAS — the shared-empties hazard, pinned as current truth')
{
  const subMsgs = [
    { message: mkAssistant([tu('toolu_sub1'), tu('toolu_sub2')]) },
    { message: M.normalizeMessages([mkUser([tr('toolu_sub1')])] as never)[0] },
  ]
  const r1 = M.buildSubagentLookups(subMsgs as never)
  const r2 = M.buildSubagentLookups(subMsgs as never)

  // The unused planes of every subagent lookup ALIAS the same singletons.
  const aliasedPlanes = [
    'siblingToolUseIDs',
    'progressMessagesByToolUseID',
    'inProgressHookCounts',
    'resolvedHookCounts',
    'erroredToolUseIDs',
    'deniedToolUseIDs',
  ] as const
  check(
    'buildSubagentLookups: unused planes alias EMPTY_LOOKUPS (both calls)',
    aliasedPlanes.every(
      p =>
        (r1.lookups as AnyMsg)[p] === (M.EMPTY_LOOKUPS as AnyMsg)[p] &&
        (r2.lookups as AnyMsg)[p] === (M.EMPTY_LOOKUPS as AnyMsg)[p],
    ),
  )
  check(
    'buildSubagentLookups: populated planes are per-call fresh',
    r1.lookups.toolUseByToolUseID !== r2.lookups.toolUseByToolUseID &&
      r1.lookups.resolvedToolUseIDs !== r2.lookups.resolvedToolUseIDs &&
      r1.lookups.toolResultByToolUseID !== r2.lookups.toolResultByToolUseID,
  )
  check(
    'buildSubagentLookups: populated planes carry the sub-conversation',
    r1.lookups.toolUseByToolUseID.size === 2 &&
      r1.lookups.resolvedToolUseIDs.has('toolu_sub1') &&
      r1.inProgressToolUseIDs.has('toolu_sub2') &&
      !r1.inProgressToolUseIDs.has('toolu_sub1'),
  )
  check(
    'EMPTY_LOOKUPS planes remain empty after heavy use',
    M.EMPTY_LOOKUPS.siblingToolUseIDs.size === 0 &&
      M.EMPTY_LOOKUPS.progressMessagesByToolUseID.size === 0 &&
      M.EMPTY_LOOKUPS.resolvedToolUseIDs.size === 0 &&
      M.EMPTY_LOOKUPS.erroredToolUseIDs.size === 0,
  )
  // EMPTY_STRING_SET identity across accessor bail-outs.
  const plain = M.normalizeMessages([mkUser('no tools here')] as never)[0]!
  const bail = M.getSiblingToolUseIDsFromLookup(plain as never, M.EMPTY_LOOKUPS as never)
  check('getSiblingToolUseIDsFromLookup bail-out returns THE EMPTY_STRING_SET', bail === M.EMPTY_STRING_SET)
}

// ════════════════════════════════════════════════════════════════════════════
section('FACTORY-QUIRKS — the mint table')
{
  const empty = M.createUserMessage({ content: '' }) as AnyMsg
  check("createUserMessage(''): NO_CONTENT substitution", typeof empty.message.content === 'string' && empty.message.content !== '')
  // The empty ARRAY passes through — [] is truthy, `content || NO_CONTENT`
  // only guards the empty STRING. Pinned as current truth (factories.ts:240);
  // change consciously with a golden re-record, never silently.
  const emptyArr = M.createUserMessage({ content: [] }) as AnyMsg
  check('QUIRK: createUserMessage([]) passes the empty ARRAY through', Array.isArray(emptyArr.message.content) && emptyArr.message.content.length === 0)

  const synth = M.createAssistantMessage({ content: 'hello' }) as AnyMsg
  check(
    'synthetic assistant: SYNTHETIC_MODEL + stop_sequence + zero usage',
    synth.message.model === M.SYNTHETIC_MODEL &&
      synth.message.stop_reason === 'stop_sequence' &&
      synth.message.stop_sequence === '' &&
      synth.message.usage.input_tokens === 0 &&
      synth.message.usage.output_tokens === 0,
  )
  check('synthetic assistant: isSyntheticMessage false for plain text', M.isSyntheticMessage(synth as never) === false)
  const interrupt = M.createUserInterruptionMessage({}) as AnyMsg
  check('interruption message: isSyntheticMessage true', M.isSyntheticMessage(interrupt as never) === true)

  const crumbs = M.createModelSwitchBreadcrumbs('opus', 'Opus 4.8') as AnyMsg[]
  check(
    'createModelSwitchBreadcrumbs: 3 messages, distinct fresh uuids',
    crumbs.length === 3 && new Set(crumbs.map(c => c.uuid)).size === 3,
  )
  const stop = M.createToolResultStopMessage('toolu_x1') as Block
  check(
    'createToolResultStopMessage: is_error CANCEL block',
    stop.type === 'tool_result' &&
      stop.tool_use_id === 'toolu_x1' &&
      stop.is_error === true &&
      stop.content === M.CANCEL_MESSAGE,
  )
}

// ════════════════════════════════════════════════════════════════════════════
section('TEXT-TABLE — extractTag / textForResubmit / wrapCommandText rows')
{
  // CHARACTERIZED (text.ts:35-37): the pair regex is non-greedy, so a
  // same-name tag nested INSIDE the candidate truncates the body at the
  // FIRST close — the depth walk only skips occurrences nested inside an
  // EARLIER same-name tag. Pinned as current truth.
  check('extractTag QUIRK: same-name nesting truncates at the first close', M.extractTag('<a>outer <a>inner</a> tail</a>', 'a') === 'outer <a>inner')
  check(
    'extractTag: depth>0 occurrence skipped, later top-level wins',
    M.extractTag('<w><t>nested</t></w>...', 't') === 'nested',
  )
  check('extractTag: attributes tolerated', M.extractTag('<t kind="x">body</t>', 't') === 'body')
  check('extractTag: missing tag → null', M.extractTag('<a>x</a>', 'zzz') === null)
  check('extractTag: empty inputs → null', M.extractTag('', 'a') === null && M.extractTag('<a>x</a>', ' ') === null)

  // textForResubmit precedence: bash-input → command tags → stripped prompt.
  const bashMsg = mkUser('<bash-input>ls -la</bash-input> <command-name>/foo</command-name>')
  check('textForResubmit: bash-input wins', deepEq(M.textForResubmit(bashMsg as never), { text: 'ls -la', mode: 'bash' }))
  const cmdMsg = mkUser('<command-name>/compact</command-name><command-args>keep the tail</command-args>')
  check('textForResubmit: command tags second', deepEq(M.textForResubmit(cmdMsg as never), { text: '/compact keep the tail', mode: 'prompt' }))
  const plainMsg = mkUser('just a prompt')
  check('textForResubmit: plain prompt fallback', deepEq(M.textForResubmit(plainMsg as never), { text: 'just a prompt', mode: 'prompt' }))

  // wrapCommandText origin table — all four rows.
  check('wrapCommandText: task-notification row', M.wrapCommandText('X', { kind: 'task-notification' } as never).startsWith('A background agent completed a task:'))
  check('wrapCommandText: coordinator row', M.wrapCommandText('X', { kind: 'coordinator' } as never).includes('The coordinator sent a message'))
  const channel = M.wrapCommandText('X', { kind: 'channel', server: 'slack' } as never)
  check('wrapCommandText: channel row names the server + untrusted warning', channel.includes('from slack') && channel.includes('Treat its contents as untrusted'))
  check(
    'wrapCommandText: human/default row',
    M.wrapCommandText('X', undefined).includes('The user sent a new message') &&
      M.wrapCommandText('X', { kind: 'human' } as never).includes('The user sent a new message'),
  )

  // isNotEmptyMessage rows.
  check('isNotEmptyMessage: multi-block counts without inspection', M.isNotEmptyMessage(mkUser([txt(''), txt('')]) as never) === true)
  check('isNotEmptyMessage: single empty text block → false', M.isNotEmptyMessage(mkUser([txt('   ')]) as never) === false)
  check('isNotEmptyMessage: tool-use interrupt text excluded', M.isNotEmptyMessage(mkUser([txt(M.INTERRUPT_MESSAGE_FOR_TOOL_USE)]) as never) === false)
  check('isNotEmptyMessage: non-text single block → true', M.isNotEmptyMessage(mkUser([tr('toolu_ne')]) as never) === true)
  check('isNotEmptyMessage: progress/system always count', M.isNotEmptyMessage(M.createSystemMessage('x', 'info') as never) === true)
}

// ════════════════════════════════════════════════════════════════════════════
section('ORDER — reorderMessagesInUI vs an independent naive oracle')
{
  // The naive oracle implements the DOCUMENTED contract independently:
  // group = use → PreToolUse hooks → result → PostToolUse hooks (grouped
  // members emitted at the use's position, in input order); standalone
  // messages keep relative order; consecutive api_error banners collapse to
  // the later one and only the trailing banner survives; synthetics append.
  // Orphaned grouped members (no use message in the window) DROP —
  // characterized current truth.
  function naiveReorder(messages: AnyMsg[], synthetics: AnyMsg[]): AnyMsg[] {
    const isUse = (m: AnyMsg): boolean =>
      m.type === 'assistant' && (m.message.content as Block[])[0]?.type === 'tool_use'
    const useId = (m: AnyMsg): string => (m.message.content as Block[])[0]!.id
    const isHook = (m: AnyMsg, ev: string): boolean =>
      m.type === 'attachment' &&
      typeof m.attachment?.type === 'string' &&
      m.attachment.type.startsWith('hook_') &&
      m.attachment.type !== 'hook_permission_decision' &&
      m.attachment.hookEvent === ev
    const isResult = (m: AnyMsg): boolean =>
      m.type === 'user' && (m.message.content as Block[])[0]?.type === 'tool_result'
    const resultId = (m: AnyMsg): string => (m.message.content as Block[])[0]!.tool_use_id

    const groups = new Map<string, { use: AnyMsg | null; pre: AnyMsg[]; result: AnyMsg | null; post: AnyMsg[] }>()
    const g = (id: string) => {
      let x = groups.get(id)
      if (!x) {
        x = { use: null, pre: [], result: null, post: [] }
        groups.set(id, x)
      }
      return x
    }
    for (const m of messages) {
      if (isUse(m)) g(useId(m)).use = m
      else if (isHook(m, 'PreToolUse')) g(m.attachment.toolUseID).pre.push(m)
      else if (isResult(m)) g(resultId(m)).result = m
      else if (isHook(m, 'PostToolUse')) g(m.attachment.toolUseID).post.push(m)
    }
    const out: AnyMsg[] = []
    const done = new Set<string>()
    for (const m of messages) {
      if (isUse(m)) {
        const id = useId(m)
        if (done.has(id)) continue
        done.add(id)
        const grp = groups.get(id)!
        if (grp.use) {
          out.push(grp.use, ...grp.pre)
          if (grp.result) out.push(grp.result)
          out.push(...grp.post)
        }
        continue
      }
      if (isHook(m, 'PreToolUse') || isHook(m, 'PostToolUse') || isResult(m)) continue
      if (m.type === 'system' && m.subtype === 'api_error') {
        const last = out.at(-1)
        if (last?.type === 'system' && last.subtype === 'api_error') out[out.length - 1] = m
        else out.push(m)
        continue
      }
      out.push(m)
    }
    out.push(...synthetics)
    const last = out.at(-1)
    return out.filter(m => m.type !== 'system' || m.subtype !== 'api_error' || m === last)
  }

  const mkApiError = (): AnyMsg => ({
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    error: { message: 'boom' },
    retryInMs: 1,
    retryAttempt: 1,
    maxRetries: 3,
    timestamp: PINNED_TS,
    uuid: nextUuid(),
  })
  const mkHook = (id: string, ev: string): AnyMsg => ({
    type: 'attachment',
    uuid: nextUuid(),
    timestamp: PINNED_TS,
    attachment: { type: 'hook_success', toolUseID: id, hookEvent: ev, hookName: 'h' },
  })

  const rand = lcg(0x0bde5)
  let mismatches = 0
  let refViolations = 0
  const N = 60
  for (let iter = 0; iter < N; iter++) {
    // Build a display corpus from normalized turns + hooks + system rows.
    let seq = 0
    const raw: AnyMsg[] = [mkUser(`prompt ${iter}`)]
    const ids: string[] = []
    const nTurns = 1 + Math.floor(rand() * 4)
    for (let t = 0; t < nTurns; t++) {
      const id = `toolu_ui_${iter}_${seq++}`
      ids.push(id)
      raw.push(mkAssistant([txt(`about ${t}`), tu(id)]))
      if (rand() < 0.8) raw.push(mkUser([tr(id)]))
    }
    let display = M.normalizeMessages(raw as never) as AnyMsg[]
    // Interleave hooks / api_errors / an orphan result at random positions.
    const inserts: AnyMsg[] = []
    for (const id of ids) {
      if (rand() < 0.5) inserts.push(mkHook(id, 'PreToolUse'))
      if (rand() < 0.5) inserts.push(mkHook(id, 'PostToolUse'))
    }
    if (rand() < 0.5) inserts.push(mkApiError())
    if (rand() < 0.4) inserts.push(mkApiError())
    if (rand() < 0.3) inserts.push(M.normalizeMessages([mkUser([tr(`toolu_ui_orphan_${iter}`)])] as never)[0] as AnyMsg)
    for (const ins of inserts) {
      const at = Math.floor(rand() * (display.length + 1))
      display = [...display.slice(0, at), ins, ...display.slice(at)]
    }
    const synthetics = rand() < 0.3 ? (M.normalizeMessages([mkAssistant([tu(`toolu_ui_live_${iter}`)])] as never) as AnyMsg[]) : []

    const got = M.reorderMessagesInUI(display as never, synthetics as never) as AnyMsg[]
    const want = naiveReorder(display, synthetics)
    if (got.length !== want.length || got.some((m, i) => m !== want[i])) mismatches++
    // Reference law: reorder never clones — every output element IS an input
    // element (or a synthetic list element).
    const pool = new Set<AnyMsg>([...display, ...synthetics])
    if (got.some(m => !pool.has(m))) refViolations++
  }
  check(`ORDER: reorderMessagesInUI ≡ naive oracle (${N} random corpora)`, mismatches === 0, `${mismatches}`)
  check('ORDER: projection only — zero cloned messages', refViolations === 0, `${refViolations}`)

  // Directed rows.
  const id = 'toolu_ui_directed'
  const useMsg = M.normalizeMessages([mkAssistant([tu(id)])] as never)[0] as AnyMsg
  const resMsg = M.normalizeMessages([mkUser([tr(id)])] as never)[0] as AnyMsg
  const pre = mkHook(id, 'PreToolUse')
  const post = mkHook(id, 'PostToolUse')
  const standalone = M.normalizeMessages([mkUser('standalone')] as never)[0] as AnyMsg
  const got = M.reorderMessagesInUI([resMsg, post, standalone, useMsg, pre] as never, [] as never) as AnyMsg[]
  check(
    'ORDER: use → pre → result → post regrouped at the use position',
    got.length === 5 && got[0] === standalone && got[1] === useMsg && got[2] === pre && got[3] === resMsg && got[4] === post,
    got.map(m => m.type).join(','),
  )
  const orphanRes = M.normalizeMessages([mkUser([tr('toolu_ui_norule')])] as never)[0] as AnyMsg
  const got2 = M.reorderMessagesInUI([orphanRes, standalone] as never, [] as never) as AnyMsg[]
  check('ORDER (characterized): an orphaned tool_result DROPS from display', got2.length === 1 && got2[0] === standalone)
  const e1 = mkApiError()
  const e2 = mkApiError()
  const got3 = M.reorderMessagesInUI([e1, standalone, e2] as never, [] as never) as AnyMsg[]
  check('ORDER: only the trailing api_error banner survives', got3.length === 2 && got3[0] === standalone && got3[1] === e2)
}

// ════════════════════════════════════════════════════════════════════════════
section('SYSMSG — boundary slice reference law + scan predicates')
{
  const a = mkUser('one')
  const b = mkAssistant('two')
  const noBoundary = [a, b]
  const sliced = M.getMessagesAfterCompactBoundary(noBoundary as never)
  check('no boundary → the SAME array reference (render-bail identity)', (sliced as unknown) === (noBoundary as unknown))

  const boundary = M.createCompactBoundaryMessage('auto', 1000) as AnyMsg
  const boundary2 = M.createCompactBoundaryMessage('manual', 2000) as AnyMsg
  const withBoundary = [a, boundary, b, boundary2, mkUser('tail')]
  check('findLastCompactBoundaryIndex: last boundary wins', M.findLastCompactBoundaryIndex(withBoundary as never) === 3)
  const sliced2 = M.getMessagesAfterCompactBoundary(withBoundary as never) as AnyMsg[]
  check(
    'boundary slice: boundary INCLUDED, elements by reference',
    sliced2.length === 2 && sliced2[0] === boundary2 && sliced2[1] === withBoundary[4],
  )
  check('isCompactBoundaryMessage discriminates subtype', M.isCompactBoundaryMessage(boundary as never) && !M.isCompactBoundaryMessage(M.createSystemMessage('x', 'info') as never))

  // countToolCalls early exit + counting semantics (per-message, not per-block).
  const callMsgs = [
    mkAssistant([tu('toolu_c1'), tu('toolu_c2')]), // one message, counts once
    mkAssistant([tu('toolu_c3')]),
    mkAssistant([txt('no tools')]),
    mkAssistant([tu('toolu_c4')]),
  ].map(m => ({ ...m, message: { ...m.message, content: (m.message.content as Block[]).map(bk => (bk.type === 'tool_use' ? { ...bk, name: 'Bash' } : bk)) } }))
  check('countToolCalls: counts messages, not blocks', M.countToolCalls(callMsgs as never, 'Bash') === 3)
  check('countToolCalls: maxCount early-exits at the cap', M.countToolCalls(callMsgs as never, 'Bash', 2) === 2)
  check('countToolCalls: other tool names unaffected', M.countToolCalls(callMsgs as never, 'Read') === 0)

  // hasSuccessfulToolCall: the MOST RECENT call's result decides.
  const seqMsgs = [
    mkAssistant([{ ...tu('toolu_h1'), name: 'Bash' }]),
    mkUser([tr('toolu_h1', 'ok', false)]),
    mkAssistant([{ ...tu('toolu_h2'), name: 'Bash' }]),
    mkUser([tr('toolu_h2', 'boom', true)]),
  ]
  check('hasSuccessfulToolCall: most recent call errored → false', M.hasSuccessfulToolCall(seqMsgs as never, 'Bash') === false)
  check('hasSuccessfulToolCall: most recent succeeded → true', M.hasSuccessfulToolCall(seqMsgs.slice(0, 2) as never, 'Bash') === true)
  check('hasSuccessfulToolCall: call without result → false', M.hasSuccessfulToolCall([seqMsgs[2]] as never, 'Bash') === false)
}

// ════════════════════════════════════════════════════════════════════════════
section('MAPPERS — the SDK↔internal mapping table (unpinned before T18)')
{
  // M1 — toInternalMessages rows.
  const asstInternal = mkAssistant([txt('sdk hello')])
  const sdkIn: AnyMsg[] = [
    { type: 'assistant', message: asstInternal.message, uuid: 'aaaaaaaa-0000-4000-8000-000000000001' },
    {
      type: 'user',
      message: { role: 'user', content: 'from sdk' },
      uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
      timestamp: '2026-01-02T00:00:00.000Z',
      isSynthetic: true,
    },
    { type: 'user', message: { role: 'user', content: 'no uuid' } },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'aaaaaaaa-0000-4000-8000-000000000003',
      compact_metadata: { trigger: 'auto', pre_tokens: 42 },
    },
    { type: 'system', subtype: 'init' },
    { type: 'result', subtype: 'success' },
  ]
  const internal = mappers.toInternalMessages(sdkIn as never) as AnyMsg[]
  check('toInternalMessages: assistant/user/compact rows map; init/result drop', internal.length === 4)
  check('toInternalMessages: assistant message object by REFERENCE', internal[0]!.message === asstInternal.message)
  check('toInternalMessages: user isMeta ← isSynthetic; uuid/timestamp preserved',
    internal[1]!.isMeta === true &&
      internal[1]!.uuid === 'aaaaaaaa-0000-4000-8000-000000000002' &&
      internal[1]!.timestamp === '2026-01-02T00:00:00.000Z')
  check('toInternalMessages: absent user uuid minted uuid-shaped',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(internal[2]!.uuid)))
  check('toInternalMessages: compact boundary carries converted metadata',
    internal[3]!.type === 'system' &&
      internal[3]!.subtype === 'compact_boundary' &&
      internal[3]!.compactMetadata.trigger === 'auto' &&
      internal[3]!.compactMetadata.preTokens === 42)

  // M2 — compact metadata round-trips, both directions, with/without segment.
  const metaNoSeg = { trigger: 'manual', preTokens: 9 }
  const seg = {
    headUuid: 'bbbbbbbb-0000-4000-8000-000000000001',
    anchorUuid: 'bbbbbbbb-0000-4000-8000-000000000002',
    tailUuid: 'bbbbbbbb-0000-4000-8000-000000000003',
  }
  const metaSeg = { trigger: 'auto', preTokens: 10, preservedSegment: seg }
  check('compact metadata: internal→SDK→internal identity (no segment)',
    deepEq(mappers.fromSDKCompactMetadata(mappers.toSDKCompactMetadata(metaNoSeg as never)), metaNoSeg))
  check('compact metadata: internal→SDK→internal identity (with segment)',
    deepEq(mappers.fromSDKCompactMetadata(mappers.toSDKCompactMetadata(metaSeg as never)), metaSeg))
  const sdkMeta = { trigger: 'auto', pre_tokens: 7, preserved_segment: { head_uuid: seg.headUuid, anchor_uuid: seg.anchorUuid, tail_uuid: seg.tailUuid } }
  check('compact metadata: SDK→internal→SDK identity',
    deepEq(mappers.toSDKCompactMetadata(mappers.fromSDKCompactMetadata(sdkMeta as never)), sdkMeta))

  // M2t — the model-transition receipt row crosses BOTH directions
  // (; before it, only compact_boundary + local_command
  // crossed and the settlement receipt vanished for SDK/headless consumers).
  const transitionInternal = {
    type: 'system',
    subtype: 'model_transition',
    previous: 'claude-opus-5',
    requested: 'gpt-5.2',
    applied: 'gpt-5.2',
    resolution: 'applied',
    boundary: 'turn-boundary',
    crossProvider: true,
    cacheDisposition: 'keyed-sections-recompute-once',
    uuid: 'cccccccc-0000-4000-8000-000000000001',
    timestamp: '2026-08-05T00:00:00.000Z',
    isMeta: false,
  }
  const sdkTransitionRows = mappers.toSDKMessages([transitionInternal] as never) as AnyMsg[]
  check('model transition: internal→SDK maps exactly one row', sdkTransitionRows.length === 1)
  const sdkT = sdkTransitionRows[0]!
  check('model transition: SDK row shape (subtype + grouped snake_case transition)',
    sdkT.type === 'system' &&
      sdkT.subtype === 'model_transition' &&
      sdkT.uuid === transitionInternal.uuid &&
      deepEq(sdkT.transition, {
        previous: 'claude-opus-5',
        requested: 'gpt-5.2',
        applied: 'gpt-5.2',
        resolution: 'applied',
        boundary: 'turn-boundary',
        cross_provider: true,
        cache_disposition: 'keyed-sections-recompute-once',
      }))
  const backRows = mappers.toInternalMessages(sdkTransitionRows as never) as AnyMsg[]
  check('model transition: SDK→internal round-trips the receipt fields',
    backRows.length === 1 &&
      backRows[0]!.subtype === 'model_transition' &&
      backRows[0]!.previous === 'claude-opus-5' &&
      backRows[0]!.requested === 'gpt-5.2' &&
      backRows[0]!.applied === 'gpt-5.2' &&
      backRows[0]!.resolution === 'applied' &&
      backRows[0]!.boundary === 'turn-boundary' &&
      backRows[0]!.crossProvider === true &&
      backRows[0]!.cacheDisposition === 'keyed-sections-recompute-once' &&
      backRows[0]!.uuid === transitionInternal.uuid)

  // M3 — toSDKMessages rows.
  const isSynthTable: Array<[AnyMsg, boolean]> = [
    [mkUser('plain'), false],
    [mkUser('meta', { isMeta: true }), true],
    [mkUser('transcript-only', { isVisibleInTranscriptOnly: true }), true],
    [mkUser('both', { isMeta: true, isVisibleInTranscriptOnly: true }), true],
  ]
  for (const [msg, want] of isSynthTable) {
    const rows = mappers.toSDKMessages([msg] as never) as AnyMsg[]
    check(
      `toSDKMessages: isSynthetic table (meta=${!!msg.isMeta}, transcriptOnly=${!!msg.isVisibleInTranscriptOnly})`,
      rows.length === 1 && Boolean(rows[0]!.isSynthetic) === want,
    )
  }
  const withResult = mkUser([tr('toolu_map1')], { toolUseResult: { stdout: 'x' } })
  const withNullResult = mkUser([tr('toolu_map2')], { toolUseResult: null })
  const withoutResult = mkUser('none')
  const sdkRows = mappers.toSDKMessages([withResult, withNullResult, withoutResult] as never) as AnyMsg[]
  check('toSDKMessages: tool_use_result rides iff toolUseResult !== undefined (null INCLUDED — pinned)',
    'tool_use_result' in sdkRows[0]! && 'tool_use_result' in sdkRows[1]! && !('tool_use_result' in sdkRows[2]!))
  check('toSDKMessages: user message object by REFERENCE', sdkRows[0]!.message === withResult.message)

  const cmdInput = M.createCommandInputMessage('<command-name>/cost</command-name>') as AnyMsg
  const cmdOutput = M.createCommandInputMessage('<local-command-stdout>$0.42 spent</local-command-stdout>') as AnyMsg
  const otherSys = M.createSystemMessage('plain note', 'info') as AnyMsg
  const sysRows = mappers.toSDKMessages([cmdInput, cmdOutput, otherSys] as never) as AnyMsg[]
  check('toSDKMessages: command INPUT metadata never leaks; informational drops', sysRows.length === 1)
  check(
    'toSDKMessages: local_command stdout → synthetic SDK assistant, unwrapped',
    sysRows[0]!.type === 'assistant' &&
      sysRows[0]!.message.model === M.SYNTHETIC_MODEL &&
      (sysRows[0]!.message.content as Block[])[0]!.text === '$0.42 spent' &&
      sysRows[0]!.uuid === cmdOutput.uuid,
  )

  // M4 — localCommandOutputToSDKAssistantMessage: ANSI stripped + unwrap.
  const ansi = '\u001b[2m<local-command-stdout>dim text</local-command-stdout>\u001b[22m'
  const sdkAsst = mappers.localCommandOutputToSDKAssistantMessage(ansi, 'cccccccc-0000-4000-8000-000000000001' as never) as AnyMsg
  check('localCommandOutput: ANSI stripped, tags unwrapped, uuid passthrough',
    (sdkAsst.message.content as Block[])[0]!.text === 'dim text' && sdkAsst.uuid === 'cccccccc-0000-4000-8000-000000000001')

  // M5 — toSDKRateLimitInfo field table.
  check('toSDKRateLimitInfo: undefined → undefined', mappers.toSDKRateLimitInfo(undefined) === undefined)
  const minimal = mappers.toSDKRateLimitInfo({ status: 'allowed' } as never) as AnyMsg
  check('toSDKRateLimitInfo: minimal carries status only', deepEq(minimal, { status: 'allowed' }))
  const full = mappers.toSDKRateLimitInfo({
    status: 'allowed_warning',
    resetsAt: 123,
    rateLimitType: 'unified',
    utilization: 0.5,
    overageStatus: 'x',
    overageResetsAt: 456,
    overageDisabledReason: 'r',
    isUsingOverage: true,
    surpassedThreshold: true,
    unifiedRateLimitFallbackAvailable: true,
  } as never) as AnyMsg
  check('toSDKRateLimitInfo: full field table maps; internal-only field STRIPPED',
    full.status === 'allowed_warning' &&
      full.resetsAt === 123 &&
      full.rateLimitType === 'unified' &&
      full.utilization === 0.5 &&
      full.overageStatus === 'x' &&
      full.overageResetsAt === 456 &&
      full.overageDisabledReason === 'r' &&
      full.isUsingOverage === true &&
      full.surpassedThreshold === true &&
      !('unifiedRateLimitFallbackAvailable' in full))

  // Assistant SDK projection: content deep-equal, blocks by reference (the
  // ExitPlanModeV2 injection path deliberately NOT exercised — it reads the
  // plan file; pins the pass-through row).
  const asst2 = mkAssistant([txt('a'), tu('toolu_map3')])
  const asstRows = mappers.toSDKMessages([asst2] as never) as AnyMsg[]
  check('toSDKMessages: assistant content blocks by reference (non-ExitPlan rows)',
    (asstRows[0]!.message.content as Block[])[0] === (asst2.message.content as Block[])[0] &&
      (asstRows[0]!.message.content as Block[])[1] === (asst2.message.content as Block[])[1])
}

// ════════════════════════════════════════════════════════════════════════════
if (failures > 0) {
  console.log(`\nnative-core message-model contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core message-model contract: green (${checks} checks)`)
