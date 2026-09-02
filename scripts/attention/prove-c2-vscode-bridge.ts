#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-c2-vscode-bridge.ts — C2 stage prover.
//
//  The in-process half of (the E2E half rides the ACP
//  conformance prover over the built dist):
//
//    §1 ACP prompt content lands in ComposerDocumentV2 — the document is a
//       VALUE over owner references (structural: no body copy in the
//       document JSON; selection text and image bytes ride side tables),
//       and the expansion is byte-equal to the legacy mapping for the real
//       shapes (text · selection resource · resource_link · image).
//    §2 planEntriesOf — the task owner's rows map deterministically onto the
//       ACP plan vocabulary (numeric-id order, status preserved verbatim).
//    §3 usageWireOf — context occupancy sums the four token classes; the
//       window resolves from the model owner (conservative default for an
//       unknown id); cost crosses only when the child reported one.
//    §4 attentionWire — the versioned wire projection of AttentionViewV1:
//       five buckets with full receipts, relation edges, needsYou; and the
//       serialization carries the view's OWN version (the versioned-events
//       leg of).
//    §5 the VS Code extension consumes CORE STATE ONLY (
//       no-webview-only-truth law, mechanically): its only requires are
//       vscode + node:child_process (no fs/net second truth), every tree
//       feeds from c.request(...), and the attention view is contributed.
//
//  Run:  ~/.bun/bin/bun run scripts/attention/prove-c2-vscode-bridge.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const {
  acpPromptToComposerDocument,
  composerDocumentBlocks,
  planEntriesOf,
  usageWireOf,
  attentionWire,
} = await import('../../src/services/acp/acpServer.ts')
const { foldAttention, emptyAttentionState } = await import(
  '../../src/services/attention/contracts.ts'
)
const { foldRelations, emptyRelationState } = await import('../../src/services/attention/relations.ts')

// ── §1 — prompt content → ComposerDocumentV2 → blocks ───────────────────────
t.section('§1 ACP prompt lands in ComposerDocumentV2 (refs in the doc, bodies aside)')
{
  const SELECTION_TEXT = 'const answer = 42'
  const IMAGE_DATA = 'aGVsbG8taW1hZ2UtYnl0ZXM='
  const material = acpPromptToComposerDocument([
    { type: 'text', text: 'fix this' },
    {
      type: 'resource',
      resource: { uri: 'file:///proj/selection.ts', text: SELECTION_TEXT, mimeType: 'text/plain' },
    },
    { type: 'resource_link', uri: 'file:///proj/linked.ts' },
    { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
  ])
  t.check('the document scope is acp-prompt', material.doc.scope === 'acp-prompt', material.doc.scope)
  t.check('the typed text is the document body', material.doc.body === 'fix this', material.doc.body)
  const kinds = material.doc.items.map(i => i.kind).join(',')
  t.check('selection · file · image shelf items in encounter order', kinds === 'selection,file,image', kinds)
  const docJson = JSON.stringify(material.doc)
  t.check(
    'NO body copy in the document (selection text rides the side table)',
    !docJson.includes(SELECTION_TEXT) && material.bodies.get(material.doc.items[0]!.id) === SELECTION_TEXT,
  )
  t.check(
    'NO image bytes in the document (base64 rides the side table)',
    !docJson.includes(IMAGE_DATA) && material.images.get(material.doc.items[2]!.id)?.data === IMAGE_DATA,
  )
  t.check(
    'selection ref is the owner URI',
    material.doc.items[0]!.ref === 'file:///proj/selection.ts',
    material.doc.items[0]!.ref,
  )

  const blocks = composerDocumentBlocks(material)
  t.check(
    'expansion is byte-equal to the legacy mapping (text · attached-resource · @path) + the image block',
    JSON.stringify(blocks) ===
      JSON.stringify([
        { type: 'text', text: 'fix this' },
        {
          type: 'text',
          text: `<attached-resource uri="file:///proj/selection.ts">\n${SELECTION_TEXT}\n</attached-resource>`,
        },
        { type: 'text', text: '@/proj/linked.ts' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA } },
      ]),
    JSON.stringify(blocks).slice(0, 300),
  )

  const empty = composerDocumentBlocks(acpPromptToComposerDocument([]))
  t.check(
    'an empty prompt still sends the one empty text block (legacy exact)',
    JSON.stringify(empty) === JSON.stringify([{ type: 'text', text: '' }]),
  )
  const textless = acpPromptToComposerDocument([
    { type: 'resource', resource: { uri: 'file:///x', mimeType: 'text/plain' } },
  ])
  t.check('a textless resource adds NO item (legacy skipped it)', textless.doc.items.length === 0)

  // The INTERLEAVED @-mention shape (wave-C review: a body-first expansion
  // tore mentions out of the sentences that named them) — encounter order
  // is byte-equal to the legacy mapping.
  const interleaved = composerDocumentBlocks(
    acpPromptToComposerDocument([
      { type: 'text', text: 'Explain ' },
      { type: 'resource_link', uri: 'file:///proj/a.ts' },
      { type: 'text', text: ' then fix ' },
      { type: 'resource_link', uri: 'file:///proj/b.ts' },
      { type: 'text', text: ' please' },
    ]),
  )
  t.check(
    'interleaved content expands in ENCOUNTER order (legacy byte-equal)',
    JSON.stringify(interleaved) ===
      JSON.stringify([
        { type: 'text', text: 'Explain ' },
        { type: 'text', text: '@/proj/a.ts' },
        { type: 'text', text: ' then fix ' },
        { type: 'text', text: '@/proj/b.ts' },
        { type: 'text', text: ' please' },
      ]),
    JSON.stringify(interleaved).slice(0, 200),
  )
}

// ── §2 — plan vocabulary ────────────────────────────────────────────────────
t.section('§2 planEntriesOf — deterministic, status-verbatim')
{
  const entries = planEntriesOf([
    { id: '10', subject: 'later task', status: 'pending' },
    { id: '2', subject: 'the work', status: 'in_progress' },
    { id: '1', subject: 'done already', status: 'completed' },
  ])
  t.check(
    'numeric-id order, subjects as content',
    entries.map(e => e.content).join('|') === 'done already|the work|later task',
    entries.map(e => e.content).join('|'),
  )
  t.check(
    'statuses cross verbatim',
    entries.map(e => e.status).join(',') === 'completed,in_progress,pending',
  )
  t.check('priority is the honest neutral (medium)', entries.every(e => e.priority === 'medium'))
}

// ── §3 — usage wire ─────────────────────────────────────────────────────────
t.section('§3 usageWireOf — LAST-round-trip occupancy, model-true window')
{
  // The wave-C review's confirmed defect: the turn-cumulative result-frame
  // sum re-counts the context per round-trip and exceeds the window. The
  // wire now reads the LAST round-trip only — its input+cache tokens ARE
  // the context.
  const wire = usageWireOf(
    { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 10 },
    'definitely-unknown-model-id',
  )
  t.check('used sums the last round-trip\'s four token classes', wire.used === 185, String(wire.used))
  t.check('an unknown model resolves the conservative default window', wire.size === 200_000, String(wire.size))
  t.check(
    'occupancy stays inside the window for a realistic multi-tool turn (the >100% class is dead)',
    (() => {
      // The review's exact scenario: 20 round-trips over a ~60k context.
      // Cumulative summing read 1,311,200/200,000; the last round-trip reads
      // its real ~60k.
      const last = usageWireOf(
        { input_tokens: 210, cache_read_input_tokens: 59_000, cache_creation_input_tokens: 800, output_tokens: 1_550 },
        'definitely-unknown-model-id',
      )
      return last.used === 61_560 && last.used <= last.size
    })(),
  )
  t.check('cost is NOT the pure wire\'s concern (session-cumulative, held by the server)', !('cost' in wire))
}

// ── §4 — attention wire ─────────────────────────────────────────────────────
t.section('§4 attentionWire — versioned five-bucket receipts + edges')
{
  const attention = foldAttention(emptyAttentionState(), [
    {
      subjectId: 'th-1',
      owner: 'workbench',
      sourceEventId: 'ev-blocker-1',
      bucket: 'needs-you',
      reasonCode: 'permission-pending',
      reasonLabel: 'a consent card waits',
      sinceMs: 1000,
      atMs: 2000,
      urgency: 0,
      title: 'the blocked thread',
    },
    {
      subjectId: 'ra-1',
      owner: 'workbench',
      sourceEventId: 'ev-review-1',
      bucket: 'ready-to-review',
      reasonCode: 'review-queued',
      reasonLabel: 'awaits review',
      sinceMs: 1500,
      atMs: 2000,
      urgency: 1,
    },
  ])
  const relations = foldRelations(emptyRelationState(), [
    {
      kind: 'spawned-by',
      from: 'th-1',
      to: 'root',
      owner: 'workbench',
      sourceEventId: 'ev-edge-1',
    },
  ])
  const view = { v: 1 as const, version: 7, atMs: 2000, attention, relations, needsYou: 1 }
  const wire = attentionWire(view)
  t.check('the wire carries the view version (versioned serialization)', wire.v === 1 && wire.version === 7)
  t.check('needsYou crosses', wire.needsYou === 1)
  const needs = wire.buckets['needs-you'] ?? []
  t.check('the needs-you item carries the FULL receipt', (() => {
    const item = needs[0]
    return (
      item !== undefined &&
      item.subjectId === 'th-1' &&
      item.reasonCode === 'permission-pending' &&
      item.reasonLabel === 'a consent card waits' &&
      item.sourceEventId === 'ev-blocker-1' &&
      item.owner === 'workbench' &&
      item.title === 'the blocked thread'
    )
  })(), JSON.stringify(needs).slice(0, 200))
  t.check(
    'the review item lands in its bucket',
    (wire.buckets['ready-to-review'] ?? [])[0]?.subjectId === 'ra-1',
  )
  t.check(
    'relation edges cross with their receipts',
    wire.edges.length === 1 &&
      wire.edges[0]!.kind === 'spawned-by' &&
      wire.edges[0]!.from === 'th-1' &&
      wire.edges[0]!.sourceEventId === 'ev-edge-1',
  )
  t.check('empty buckets serialize as absent, never fabricated', !('stalled' in wire.buckets))
}

// ── §4b — the PRODUCTION crossing: the pure fold over a real snapshot ───────
t.section('§4b attentionWireFromSnapshot — the ACP route is the bridge fold, never a dormant store')
{
  const { attentionWireFromSnapshot } = await import('../../src/services/acp/acpServer.ts')
  const snap = {
    refreshedAt: 5000,
    threads: [
      {
        id: 'th-9',
        kind: 'agent',
        title: 'the blocked agent',
        phase: 'working',
        state: 'running',
        blocker: 'a consent card waits',
        startedAt: 4000,
        updatedAt: 4900,
        changedPaths: [],
        parentId: 'root',
      },
    ],
    reviewQueue: [{ ref: 'mercury://artifact/ra-77', note: 'plan v2 awaits review' }],
    lanes: [],
  }
  const wire = attentionWireFromSnapshot(snap as never)
  t.check('the wire versions by the snapshot\'s own mint stamp', wire.version === 5000, String(wire.version))
  t.check(
    'the blocker crosses as needs-you (the same translation the TUI gatherer runs)',
    wire.needsYou === 1 && (wire.buckets['needs-you'] ?? [])[0]?.reasonLabel === 'a consent card waits',
    JSON.stringify(wire.buckets['needs-you'] ?? []).slice(0, 160),
  )
  t.check(
    'the review row crosses as ready-to-review',
    (wire.buckets['ready-to-review'] ?? [])[0]?.subjectId === 'review:mercury://artifact/ra-77',
  )
  t.check(
    'the spawned-by edge crosses',
    wire.edges.some(e => e.kind === 'spawned-by' && e.from === 'thread:th-9'),
  )
  // The dishonesty class this replaces, pinned dead: the ACP handler source
  // computes the wire FROM the snapshot — no store subscribe, no scoped arm.
  const src = readFileSync('src/services/acp/acpServer.ts', 'utf8')
  t.check(
    'the ACP handler folds the snapshot (no store arm in the server)',
    src.includes('attentionWireFromSnapshot(snap)') && !src.includes('subscribeAttentionView'),
  )
}

// ── §5 — the extension consumes core state only ─────────────────────────────
t.section('§5 VS Code extension: no webview-only truth (RV-28)')
{
  const src = readFileSync('integrations/vscode/extension.js', 'utf8')
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]!)
  // No second truth: the editor-side surfaces read Mercury's state through
  // the ACP client only. The node modules the extension carries serve the
  // OTHER direction — the terminal bridge, where the editor is the owner of
  // the facts it serves (its documents, selection, diagnostics) and of its
  // own advertisement file — never a store of Mercury's facts.
  const allowed = new Set(['vscode', 'node:child_process', 'node:http', 'node:fs', 'node:os', 'node:path', 'node:crypto'])
  const foreign = requires.filter(r => !allowed.has(r))
  t.check(
    'the requires are vscode + the ACP child pipe + the terminal bridge\'s node modules (no fs/net read of Mercury state)',
    foreign.length === 0,
    foreign.join(', '),
  )
  t.check(
    'the ACP side never reads Mercury state from disk (no fs read outside the terminal bridge + preview)',
    !/readFileSync\([^)]*(session|transcript|artifact|workbench)/i.test(src),
  )
  const trees = [...src.matchAll(/new SimpleTree\(async \(\) => \{([\s\S]*?)\n  \}\)/g)]
  t.check('the tree views exist (sessions · workbench · artifacts · attention)', trees.length >= 4, String(trees.length))
  t.check(
    'EVERY tree feeds from the ACP client (c.request), never a local store',
    trees.every(m => m[1]!.includes('c.request(')),
  )
  t.check('the attention view is registered', src.includes("registerTreeDataProvider('mercuryAttention'"))
  t.check(
    'the attention rows render the receipt truth (reasonLabel crossing)',
    src.includes('attention') && src.includes('reasonLabel'),
  )
  t.check(
    'plan · usage_update · mode updates are handled in the chat surface',
    src.includes("'plan'") && src.includes("'usage_update'") && src.includes("'current_mode_update'"),
  )
  const pkg = JSON.parse(readFileSync('integrations/vscode/package.json', 'utf8')) as {
    contributes?: { views?: Record<string, Array<{ id: string }>> }
  }
  const viewIds = Object.values(pkg.contributes?.views ?? {})
    .flat()
    .map(v => v.id)
  t.check(
    'package.json contributes the attention view',
    viewIds.includes('mercuryAttention'),
    viewIds.join(', '),
  )
}

t.finish('prove-c2-vscode-bridge')
