#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-fabric-domain.ts — IDM-1/2: the canonical
//  record model exists, validates, and the entry codec is TOTAL and
//  LOSSLESS: the write seam (entryToRecord) and the read seam
//  (recordToEntry) are exact inverses through the durable MercuryRecord
//  format.
//
//  §A ordinal codec laws (JSON-safe, scoped, insertable, restart-safe).
//  §B codec exhaustiveness: one instance of EVERY entry variant — the
//     Message families, all 18 system subtypes, the full logs.ts Entry
//     union, and an unknown future kind — encodes, validates, and projects
//     back to a deep-equal entry (the round-trip over MercuryRecord).
//  §C round-trip over MercuryRecord on the seeded corpus (1,011 entries,
//     full toolUseResult shapes): every entry encodes → validates →
//     round-trips byte-faithfully at the JSON level.
//  §D the import fence, fabric core: zero provider-package imports
//     anywhere under src/fabric/ (the IDM-1 firewall's fixed floor).
//  §E unknown-retention: a newer-schema record validates into
//     unknown-retained instead of vanishing; malformed structure fails
//     loudly with typed issues.
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const { asOrdinal, betweenOrdinals, compareOrdinals, nextOrdinal, ordinalOf } = await import(
  '../../src/fabric/ordinal.js'
)
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.js')
const { validateRecord } = await import('../../src/fabric/validate.js')
const { buildCompass1k } = await import('../navigation/fixture1k.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const jsonEq = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown): string => {
    const sort = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(sort)
      if (x && typeof x === 'object') {
        return Object.fromEntries(
          Object.entries(x as Record<string, unknown>)
            .filter(([, val]) => val !== undefined)
            .sort(([p], [q]) => (p < q ? -1 : 1))
            .map(([k, val]) => [k, sort(val)]),
        )
      }
      return x
    }
    return JSON.stringify(sort(JSON.parse(JSON.stringify(v))))
  }
  return norm(a) === norm(b)
}

const ctx = () => {
  let n = 0
  return {
    sessionId: '00000000-aaaa-4000-8000-000000000001' as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-08-03T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
}

function roundTrip(label: string, line: Record<string, unknown>): void {
  const rec = entryToRecord(line, ctx() as never)
  const validated = validateRecord(JSON.parse(JSON.stringify(rec)))
  if (!validated.ok) {
    check(`${label}: validates`, false, validated.issues.map(i => `${i.path}: ${i.message}`).slice(0, 2).join(' · '))
    return
  }
  const back = recordToEntry(validated.record)
  check(`${label}: lossless round-trip`, jsonEq(back, line), JSON.stringify(back).slice(0, 140))
}

// ── §A ordinal laws ─────────────────────────────────────────────────────────
section('§A ordinal codec laws')
{
  check('canonical forms accepted', (() => { asOrdinal('0'); asOrdinal('7'); asOrdinal('7.5'); return true })())
  check('non-canonical rejected', (() => { try { asOrdinal('07'); return false } catch { /* expected */ } try { asOrdinal('7.50'); return false } catch { /* expected */ } try { asOrdinal('-1'); return false } catch { return true } })())
  check('restart-safe next: floor(tail)+1', nextOrdinal(asOrdinal('7.5')) === '8' && nextOrdinal(null) === '1')
  const mid = betweenOrdinals(asOrdinal('7'), asOrdinal('8'))
  check('insertion bisects between neighbors', compareOrdinals(asOrdinal('7'), mid) === -1 && compareOrdinals(mid, asOrdinal('8')) === -1)
}

// ── §B exhaustive legacy variants ───────────────────────────────────────────
section('§B codec exhaustiveness — every entry variant round-trips')
{
  const base = {
    uuid: '00000000-bbbb-4000-8000-000000000002',
    timestamp: '2026-08-01T10:00:00.000Z',
    parentUuid: null,
    isSidechain: false,
    sessionId: '00000000-aaaa-4000-8000-000000000001',
    userType: 'external',
    cwd: '/tmp/x',
    version: '1.3.0',
    gitBranch: 'main',
  }
  roundTrip('assistant (text+thinking+redacted+tool_use, full usage, stop end_turn)', {
    ...base,
    type: 'assistant',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      container: null,
      context_management: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [
        { type: 'text', text: 'hello', citations: [] },
        { type: 'thinking', thinking: 'hmm', signature: 'sig-bytes' },
        { type: 'redacted_thinking', data: 'opaque-red' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
      ],
      usage: {
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1 },
        server_tool_use: { web_search_requests: 0 }, service_tier: 'standard', inference_geo: null,
        iterations: null, speed: null, novel_future_field: { x: 1 },
      },
    },
  })
  roundTrip('assistant (refusal outcome + apexProviderTurn + error fields)', {
    ...base,
    type: 'assistant',
    requestId: undefined,
    error: 'rate_limit',
    errorDetails: 'slow down',
    isApiErrorMessage: true,
    apexProviderTurn: { provider: 'openai', responseId: 'resp_9', items: [{ k: 1 }] },
    message: {
      id: 'msg_2', type: 'message', role: 'assistant', model: '<synthetic>',
      stop_reason: 'refusal', stop_sequence: '', content: [{ type: 'text', text: 'no' }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
  roundTrip('assistant (context-limit + output-limit bijection)', {
    ...base,
    type: 'assistant',
    message: {
      id: 'msg_3', type: 'message', role: 'assistant', model: 'm',
      stop_reason: 'model_context_window_exceeded', stop_sequence: null, content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
  roundTrip('user (plain string)', {
    ...base, type: 'user', message: { role: 'user', content: 'do the thing' },
  })
  roundTrip('user (tool_result blocks + toolUseResult null + meta flags)', {
    ...base,
    type: 'user',
    isMeta: true,
    isVisibleInTranscriptOnly: true,
    toolUseResult: null,
    imagePasteIds: [1, 2],
    sourceToolUseID: 'toolu_1',
    origin: { kind: 'channel', server: 'ops' },
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { data: 'zz' } }] },
        { type: 'text', text: 'follow-up' },
        { type: 'document', source: { media_type: 'application/pdf' } },
        { type: 'future_block_kind', mystery: true },
      ],
    },
  })
  roundTrip('progress', {
    ...base, type: 'progress', toolUseID: 'toolu_7', parentToolUseID: 'toolu_1', data: { type: 'bash_progress', elapsed: 3 },
  })
  roundTrip('attachment', {
    ...base, type: 'attachment', attachment: { type: 'system_reminder', text: 'remember', files: ['a.ts'] },
  })
  for (const sub of [
    'informational', 'party_event', 'seat_receipt', 'permission_retry', 'bridge_status',
    'scheduled_task_fire', 'stop_hook_summary', 'turn_duration', 'away_summary', 'memory_saved',
    'agents_killed', 'api_metrics', 'local_command', 'api_error', 'file_snapshot', 'thinking',
    'model_transition',
  ]) {
    roundTrip(`system:${sub}`, {
      ...base, type: 'system', subtype: sub, content: `c-${sub}`, level: 'info', extraField: { deep: [1] },
    })
  }
  roundTrip('system:compact_boundary', {
    ...base, type: 'system', subtype: 'compact_boundary', content: 'compacted', level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 9000, preservedSegment: { headUuid: base.uuid, anchorUuid: base.uuid, tailUuid: base.uuid } },
    logicalParentUuid: '00000000-bbbb-4000-8000-000000000009',
  })
  roundTrip('system:microcompact_boundary', {
    ...base, type: 'system', subtype: 'microcompact_boundary', content: 'micro', level: 'info',
    microcompactMetadata: { trigger: 'auto', preTokens: 1, tokensSaved: 2, compactedToolIds: [], clearedAttachmentUUIDs: [] },
  })
  for (const entry of [
    { type: 'summary', summary: 'sess', leafUuid: base.uuid },
    { type: 'custom-title', title: 't', sessionId: base.sessionId },
    { type: 'ai-title', title: 'ai', sessionId: base.sessionId },
    { type: 'last-prompt', prompt: 'p', sessionId: base.sessionId },
    { type: 'task-summary', summary: 's', sessionId: base.sessionId },
    { type: 'tag', tag: 'x', sessionId: base.sessionId, timestamp: base.timestamp },
    { type: 'agent-name', name: 'scout', sessionId: base.sessionId },
    { type: 'agent-color', color: 'blue', sessionId: base.sessionId },
    { type: 'agent-setting', setting: 'k', value: 'v' },
    { type: 'pr-link', number: 7, url: 'https://x', repository: 'r' },
    { type: 'mode', mode: 'coordinator', timestamp: base.timestamp },
    { type: 'worktree-state', state: null, timestamp: base.timestamp },
    { type: 'content-replacement', replacements: [{ uuid: base.uuid }] },
    { type: 'file-history-snapshot', messageId: base.uuid, snapshot: { files: {} }, isSnapshotUpdate: false },
    { type: 'attribution-snapshot', files: {}, timestamp: base.timestamp },
    { type: 'queue-operation', operation: 'enqueue', timestamp: base.timestamp, sessionId: base.sessionId, content: 'queued' },
    { type: 'speculation-accept', uuid: base.uuid, accepted: true },
    { type: 'marble-origami-commit', commitId: 'c1', timestamp: base.timestamp },
    { type: 'marble-origami-snapshot', snapshotId: 's1', timestamp: base.timestamp },
  ]) {
    roundTrip(`entry:${entry.type}`, entry as Record<string, unknown>)
  }
}

// ── §C the seeded 1k corpus ─────────────────────────────────────────────────
section('§C round-trip over MercuryRecord — the 1k corpus (seeded, byte-identical)')
{
  const { lines } = buildCompass1k('/tmp/compass-fixture-cwd')
  let mapped = 0
  let validated = 0
  let equal = 0
  const failuresDetail: string[] = []
  const c = ctx()
  for (const line of lines) {
    const rec = entryToRecord(line, c as never)
    mapped++
    const v = validateRecord(JSON.parse(JSON.stringify(rec)))
    if (!v.ok) {
      if (failuresDetail.length < 3) failuresDetail.push(`validate: ${JSON.stringify(line).slice(0, 80)} → ${v.issues[0]?.path}: ${v.issues[0]?.message}`)
      continue
    }
    validated++
    const back = recordToEntry(v.record)
    if (jsonEq(back, line)) equal++
    else if (failuresDetail.length < 3) failuresDetail.push(`roundtrip: ${JSON.stringify(line).slice(0, 100)}`)
  }
  check(`all ${lines.length} corpus lines map`, mapped === lines.length, String(mapped))
  check(`all ${lines.length} mapped records validate`, validated === lines.length, `${validated}/${lines.length} · ${failuresDetail.join(' | ')}`)
  check(`all ${lines.length} round-trip losslessly`, equal === lines.length, `${equal}/${lines.length} · ${failuresDetail.join(' | ')}`)
}

// ── §D the import fence, fabric core ────────────────────────────────────────
section('§D import fence — src/fabric/ has zero provider-package imports')
{
  const offenders: string[] = []
  for (const f of readdirSync(join(ROOT, 'src/fabric'))) {
    const text = readFileSync(join(ROOT, 'src/fabric', f), 'utf8')
    if (/@anthropic-ai\/|from 'openai|@modelcontextprotocol\//.test(text)) offenders.push(f)
  }
  check('zero provider imports anywhere under src/fabric/', offenders.length === 0, offenders.join(', '))
}

// ── §E retention + loud corruption ──────────────────────────────────────────
section('§E unknown-retention + typed corruption failure')
{
  const good = entryToRecord({ type: 'user', uuid: '00000000-bbbb-4000-8000-00000000000a', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'x' } }, ctx() as never)
  const newer = { ...JSON.parse(JSON.stringify(good)), schemaVersion: 99, payload: { kind: 'hologram', beam: true } }
  const v1 = validateRecord(newer)
  check('newer-schema unknown kind validates into unknown-retained', v1.ok && v1.record.payload.kind === 'unknown-retained' && (v1.record.payload as { sourceKind?: string }).sourceKind === 'hologram')
  const v2 = validateRecord({ schemaVersion: 1, payload: null })
  check('structural corruption fails with typed issues', !v2.ok && v2.issues.length > 0)
  const v3 = validateRecord('not even an object')
  check('non-object fails typed', !v3.ok)
}

console.log(failures === 0 ? '\n ✅ FABRIC DOMAIN PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
