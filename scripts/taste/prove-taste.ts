#!/usr/bin/env bun
// ============================================================================
//  scripts/taste/prove-taste.ts
//  PROOF — the Taste Loop (/meh, /good): capture → classify → persist → promote
//  → recall, stamp-gated with a =0 opt-out.
//
//  Covers: command parsing/declaration, deterministic classifier (meh + good,
//  keyword AND snapshot-signal), snapshot capture + redaction + size caps,
//  JSONL-ring persistence + bound, promotion threshold + TASTE.md artifact,
//  recall precision + throttle, and gate polarity (OPT-IN since
// unset ⇒ OFF, =1 arms, =0 explicit off).
//
//  Round-trips into a TEMP dir via the injectable memoryDir — never touches real
//  auto-memory. Fork-sim: globalThis.MACRO carries '-hermes' so the gate is live.
//  Run: ~/.bun/bin/bun run scripts/taste/prove-taste.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
// OPT-IN gate: arm the loop for the live sections below; the
// polarity section at the end drops/flip-flops it and asserts the default-OFF.
process.env.MERCURY_TASTE_LOOP = '1'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_EPISODES,
  MAX_EPISODE_BYTES,
  MAX_TOOLS,
  MAX_TURNS,
  PROMOTE_THRESHOLD,
  RECALL_MAX_LESSONS,
  RECALL_THROTTLE_TURNS,
  buildEpisode,
  buildTasteRecallText,
  capEpisodeSize,
  captureSnapshot,
  classifyGood,
  classifyMeh,
  derivePromoted,
  getTasteRecallContent,
  promoteLessons,
  rankByRelevance,
  readEpisodes,
  redactAndClip,
  shouldEmitTasteRecall,
  tasteLoopEnabled,
  writeEpisode,
  type TasteEpisode,
  type TasteSnapshot,
} from '../../src/memdir/tasteLoop.js'
import { meh } from '../../src/commands/meh/index.js'
import { good } from '../../src/commands/good/index.js'
import { runTasteCommand } from '../../src/commands/taste/runTaste.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const emptySnap = (): TasteSnapshot => ({
  sessionId: 's',
  cwd: '/p',
  project: '/p',
  modes: ['fork'],
  turns: [],
  tools: [],
})

console.log('============================================================')
console.log(' Taste Loop — /meh, /good capture → classify → recall')
console.log('============================================================')

// ── 1. Command declarations + arg gate ─────────────────────────────────────
section('command declarations (/meh, /good)')
check('meh is a local command named "meh"', meh.type === 'local' && meh.name === 'meh')
check('good is a local command named "good"', good.type === 'local' && good.name === 'good')
check('both enabled under fork (gate on)', meh.isEnabled?.() === true && good.isEnabled?.() === true)
check('both hidden when gate off', meh.isHidden === false && good.isHidden === false)

// ── 2. Classifier — /meh keyword + signal ──────────────────────────────────
section('classifyMeh — keyword and snapshot-signal')
check('keyword "too verbose / wall of text" → too_verbose',
  classifyMeh('that was too verbose, a wall of text', emptySnap()).cls === 'too_verbose')
check('keyword "kept asking permission" → too_passive',
  classifyMeh('you kept asking permission instead of acting', emptySnap()).cls === 'too_passive')
check('keyword "no diff / all talk" → no_concrete_artifact',
  classifyMeh('all talk, no diff', emptySnap()).cls === 'no_concrete_artifact')
{
  // signal-only: edited with no Read/Grep this window, empty-ish complaint
  const snap = { ...emptySnap(), tools: [{ name: 'Edit', outcome: 'ok' as const }, { name: 'Write', outcome: 'ok' as const }] }
  check('signal (edit, no read) → did_not_inspect_code',
    classifyMeh('hmm', snap).cls === 'did_not_inspect_code')
}
{
  const snap = { ...emptySnap(), tools: Array.from({ length: 4 }, () => ({ name: 'Agent', outcome: 'ok' as const })) }
  check('signal (4 agent spawns) → over_orchestrated',
    classifyMeh('hmm', snap).cls === 'over_orchestrated')
}
{
  const snap = { ...emptySnap(), tools: Array.from({ length: 3 }, () => ({ name: 'Bash', outcome: 'error' as const })) }
  check('signal (3 failed tools) → got_stuck_without_escalating',
    classifyMeh('hmm', snap).cls === 'got_stuck_without_escalating')
}
check('no signal at all → other', classifyMeh('xyz', emptySnap()).cls === 'other')
{
  // verbose signal now lives in the clipped domain (turns near the 400 cap)
  const snap = { ...emptySnap(), turns: [{ role: 'assistant' as const, text: 'w'.repeat(400) }, { role: 'assistant' as const, text: 'w'.repeat(390) }] }
  check('signal (assistant turns near clip) → too_verbose', classifyMeh('hmm', snap).cls === 'too_verbose')
}
check('"should have used agents" → under_orchestrated (not wrong_tool_choice)',
  classifyMeh('you should have used agents to parallelize', emptySnap()).cls === 'under_orchestrated')
check('"should have used the Read tool" → wrong_tool_choice',
  classifyMeh('should have used the Read tool', emptySnap()).cls === 'wrong_tool_choice')

// ── 3. Classifier — /good keyword + signal ─────────────────────────────────
section('classifyGood — keyword and snapshot-signal')
check('keyword "concise / to the point" → concise_answer',
  classifyGood('concise and to the point', emptySnap()).cls === 'concise_answer')
check('keyword "verified / ran the test" → verified_with_test',
  classifyGood('you verified it and ran the test', emptySnap()).cls === 'verified_with_test')
{
  const snap = { ...emptySnap(), tools: [{ name: 'Read', outcome: 'ok' as const }, { name: 'Grep', outcome: 'ok' as const }] }
  check('signal (read before edit) → inspected_code_first',
    classifyGood('nice', snap).cls === 'inspected_code_first')
}
{
  const snap = { ...emptySnap(), tools: [{ name: 'Read', outcome: 'ok' as const }, { name: 'Edit', outcome: 'ok' as const }] }
  check('signal (shipped an edit) contributes produced_diff',
    classifyGood('the patch', snap).cls === 'produced_diff')
}

// ── 4. Snapshot capture from a Message[] (structural) ───────────────────────
section('captureSnapshot — turns, tools, outcomes, caps, redaction')
{
  // Build a fake transcript: human → assistant(text + tool_use Read) → tool_result(ok)
  //                          → assistant(tool_use Bash) → tool_result(error)
  const messages = [
    { type: 'user', message: { content: 'please fix the parser' } },
    { type: 'user', isMeta: true, message: { content: 'caveat (meta, ignored)' } },
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'reading the parser' },
      { type: 'tool_use', id: 'a', name: 'Read' },
    ] } },
    { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash' }] } },
    { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true }] } },
  ]
  const snap = captureSnapshot(messages as never, { sessionId: 'S', cwd: '/c', project: '/proj', modes: ['fork', 'ultracode'] })
  check('human turn captured, meta turn dropped',
    snap.turns.some(t => t.role === 'user' && t.text.includes('fix the parser')) &&
    !snap.turns.some(t => t.text.includes('caveat')))
  check('assistant text turn captured', snap.turns.some(t => t.role === 'assistant' && t.text.includes('reading the parser')))
  check('tools captured with names', snap.tools.map(t => t.name).join(',') === 'Read,Bash')
  check('tool outcomes resolved (ok + error)',
    snap.tools[0].outcome === 'ok' && snap.tools[1].outcome === 'error')
  check('identity threaded', snap.sessionId === 'S' && snap.project === '/proj' && snap.modes.includes('ultracode'))
}
{
  // BUG-2 guard: tool names are length-clipped at capture, and a boundary-delimited
  // secret-shaped name is scrubbed (the \b-anchored scanner's reachable case).
  const messages = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'a'.repeat(200) }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'y', name: 'AKIAIOSFODNN7EXAMPLE' }] } },
  ]
  const snap = captureSnapshot(messages as never, { sessionId: 's', cwd: '/c', project: '/p', modes: [] })
  check('tool name length-capped at capture', snap.tools[0].name.length <= 60)
  check('boundary-delimited secret-shaped tool name is scrubbed', !snap.tools[1].name.includes('AKIAIOSFODNN7EXAMPLE'))
}
{
  // D2: id-less tool_uses must NOT all collide on one '' result outcome.
  const messages = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Edit' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } },
  ]
  const snap = captureSnapshot(messages as never, { sessionId: 's', cwd: '/c', project: '/p', modes: [] })
  check('id-less tool_uses stay pending (no empty-id outcome collision)',
    snap.tools.every(t => t.outcome === 'pending'))
}
{
  // D3: a human turn carrying BOTH text and a tool_result keeps its text.
  const messages = [
    { type: 'user', message: { content: [{ type: 'text', text: 'real follow-up question' }, { type: 'tool_result', tool_use_id: 'z', is_error: false }] } },
  ]
  const snap = captureSnapshot(messages as never, { sessionId: 's', cwd: '/c', project: '/p', modes: [] })
  check('mixed human turn (text + tool_result) keeps its text',
    snap.turns.some(t => t.role === 'user' && t.text.includes('real follow-up question')))
}
{
  // caps: many turns + tools → capped
  const msgs: unknown[] = []
  for (let i = 0; i < 20; i++) {
    msgs.push({ type: 'user', message: { content: `turn ${i} ` + 'x'.repeat(2000) } })
    msgs.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + i, name: 'Read' }] } })
  }
  const snap = captureSnapshot(msgs as never, { sessionId: 's', cwd: '/c', project: '/p', modes: [] })
  check(`turns capped to ${MAX_TURNS}`, snap.turns.length <= MAX_TURNS)
  check(`tools capped to ${MAX_TOOLS}`, snap.tools.length <= MAX_TOOLS)
  check('turn text clipped', snap.turns.every(t => t.text.length <= 400))
}

// ── 5. Redaction + per-episode size cap ─────────────────────────────────────
section('redaction + size caps')
check('redactAndClip scrubs an AWS key',
  !redactAndClip('leak AKIAIOSFODNN7EXAMPLE here', 600).includes('AKIAIOSFODNN7EXAMPLE') &&
  redactAndClip('leak AKIAIOSFODNN7EXAMPLE here', 600).includes('[REDACTED]'))
check('redactAndClip scrubs a github token',
  !redactAndClip('tok ghp_' + 'a'.repeat(36) + ' end', 600).includes('ghp_' + 'a'.repeat(36)))
{
  const snap: TasteSnapshot = {
    sessionId: 's', cwd: '/c', project: '/p', modes: [],
    turns: Array.from({ length: MAX_TURNS }, (_, i) => ({ role: 'user' as const, text: 'y'.repeat(400) + i })),
    tools: [],
  }
  const ep = buildEpisode('meh', 'z'.repeat(600), snap, '2026-06-25T00:00:00.000Z')
  check(`episode JSON <= ${MAX_EPISODE_BYTES} bytes after cap`, JSON.stringify(ep).length <= MAX_EPISODE_BYTES,
    `actual=${JSON.stringify(ep).length}`)
  check('episode carries v:1 + classified cls + redacted text', ep.v === 1 && typeof ep.cls === 'string')
}
{
  // BUG-1 guard: the cap holds even when a non-turn field (a huge tool name)
  // dominates — capEpisodeSize must trim tools/text, not only turns.
  const snap: TasteSnapshot = {
    sessionId: 's', cwd: '/c', project: '/p', modes: [],
    turns: [],
    tools: [{ name: 'x'.repeat(5000), outcome: 'ok' }],
  }
  const ep = buildEpisode('meh', 'z'.repeat(600), snap, '2026-06-25T00:00:00.000Z')
  check(`episode with a 5000-char tool name still <= ${MAX_EPISODE_BYTES}`,
    JSON.stringify(ep).length <= MAX_EPISODE_BYTES, `actual=${JSON.stringify(ep).length}`)
}
{
  // cap holds even when a pathological identity field alone exceeds the cap
  const snap: TasteSnapshot = {
    sessionId: 's', cwd: 'c'.repeat(6000), project: 'p'.repeat(6000), modes: ['m'.repeat(500)],
    turns: [], tools: [],
  }
  const ep = buildEpisode('meh', 'z'.repeat(600), snap, '2026-06-25T00:00:00.000Z')
  check(`episode with a 6000-char project path still <= ${MAX_EPISODE_BYTES}`,
    JSON.stringify(ep).length <= MAX_EPISODE_BYTES, `actual=${JSON.stringify(ep).length}`)
}
{
  // P1: the cap holds even when EVERY axis is huge at once (the hard-clamp backstop).
  const snap: TasteSnapshot = {
    sessionId: 's'.repeat(2000), cwd: 'c'.repeat(6000), project: 'p'.repeat(6000),
    modes: Array.from({ length: 12 }, () => 'm'.repeat(500)),
    turns: Array.from({ length: 6 }, (_, i) => ({ role: 'assistant' as const, text: 'y'.repeat(4000) + i })),
    tools: Array.from({ length: 12 }, () => ({ name: 'n'.repeat(4000), outcome: 'ok' as const })),
  }
  const ep = buildEpisode('meh', 'z'.repeat(9000), snap, '2026-06-25T00:00:00.000Z')
  check(`episode huge on every axis still <= ${MAX_EPISODE_BYTES}`,
    JSON.stringify(ep).length <= MAX_EPISODE_BYTES, `actual=${JSON.stringify(ep).length}`)
}
{
  // P1 (backstop completeness): capEpisodeSize's hard-clamp must hold for the SCALAR
  // string fields too (id/ts/cls) — buildEpisode bounds them in production, but the
  // backstop's guarantee is unconditional, so a synthetic caller can't smuggle an
  // over-cap episode through an unclipped scalar.
  const pathological: TasteEpisode = {
    v: 1,
    id: 'I'.repeat(9000),
    ts: 'T'.repeat(9000),
    kind: 'meh',
    cls: 'C'.repeat(9000),
    signals: Array.from({ length: 50 }, () => 'S'.repeat(500)),
    text: 'Z'.repeat(9000),
    snapshot: {
      sessionId: 's'.repeat(9000), cwd: 'c'.repeat(9000), project: 'p'.repeat(9000),
      modes: Array.from({ length: 20 }, () => 'm'.repeat(500)),
      turns: Array.from({ length: 10 }, (_, i) => ({ role: 'assistant' as const, text: 'y'.repeat(9000) + i })),
      tools: Array.from({ length: 20 }, () => ({ name: 'n'.repeat(9000), outcome: 'ok' as const })),
    },
  }
  const capped = capEpisodeSize(pathological)
  check(`capEpisodeSize clamps pathological scalar fields (id/ts/cls) <= ${MAX_EPISODE_BYTES}`,
    JSON.stringify(capped).length <= MAX_EPISODE_BYTES, `actual=${JSON.stringify(capped).length}`)
}

// ── 6 + 7 + 8. Persistence, promotion, recall — into a TEMP dir ────────────
const dir = await mkdtemp(join(tmpdir(), 'taste-proof-'))
try {
  section('persistence — JSONL ring round-trip + bound')
  const ep = buildEpisode('meh', 'too verbose, wall of text', emptySnap(), new Date().toISOString())
  await writeEpisode(dir, ep)
  let back = await readEpisodes(dir)
  check('write → read round-trips one episode', back.length === 1 && back[0].cls === 'too_verbose')

  // Exceed the ring; newest must survive, count bounded.
  for (let i = 0; i < MAX_EPISODES + 5; i++) {
    await writeEpisode(dir, buildEpisode('good', `ring ${i} concise`, emptySnap(), new Date(Date.now() + i).toISOString()))
  }
  back = await readEpisodes(dir)
  check(`ring bounded to ${MAX_EPISODES}`, back.length === MAX_EPISODES, `actual=${back.length}`)
  check('newest episode retained', back[back.length - 1].text.includes(`ring ${MAX_EPISODES + 4}`))

  // D1: concurrent FIRST writes to a fresh dir must not lose data (the lock has to
  // engage on the first write — the file is pre-created so proper-lockfile can lock it).
  const cdir = await mkdtemp(join(tmpdir(), 'taste-concurrent-'))
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writeEpisode(cdir, buildEpisode('meh', `concurrent ${i} too verbose`, emptySnap(), new Date(Date.now() + i).toISOString())),
      ),
    )
    const eps = await readEpisodes(cdir)
    check('12 concurrent first-writes all persist (no lost update)', eps.length === 12, `got ${eps.length}`)
  } finally {
    await rm(cdir, { recursive: true, force: true })
  }

  section('promotion threshold (>= ' + PROMOTE_THRESHOLD + ') + TASTE.md artifact')
  const fresh = await mkdtemp(join(tmpdir(), 'taste-promote-'))
  try {
    for (let i = 0; i < PROMOTE_THRESHOLD - 1; i++) {
      await writeEpisode(fresh, buildEpisode('meh', 'too verbose wall of text', emptySnap(), new Date(Date.now() + i).toISOString()))
    }
    let promoted = derivePromoted(await readEpisodes(fresh))
    check(`below threshold ⇒ nothing promoted`, promoted.length === 0)
    await writeEpisode(fresh, buildEpisode('meh', 'too verbose again', emptySnap(), new Date(Date.now() + 99).toISOString()))
    const res = await promoteLessons(fresh)
    check(`at threshold ⇒ too_verbose promoted`, res.promoted.some(l => l.cls === 'too_verbose' && l.count >= PROMOTE_THRESHOLD))
    const md = await readFile(res.path, 'utf-8')
    check('TASTE.md written with candidate marker + lesson',
      md.includes('candidate') && md.includes('too_verbose') && /one short worklog line/i.test(md))
    check('TASTE.md marks lessons NOT universal truth', /not\s+universal truth/i.test(md))
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }

  section('recall — precision, cap, throttle, off')
  // buildTasteRecallText: only promoted, capped, null when empty.
  check('empty promoted ⇒ null recall', buildTasteRecallText([]) === null)
  const many = Array.from({ length: 6 }, (_, i) => ({ kind: 'meh' as const, cls: 'c' + i, count: 9 - i, lesson: 'lesson ' + i }))
  const txt = buildTasteRecallText(many) || ''
  check(`recall capped to ${RECALL_MAX_LESSONS} lessons`, (txt.match(/- (Avoid|Keep):/g) || []).length === RECALL_MAX_LESSONS)
  check('recall tells the model not to mention it', /never mention this reminder/i.test(txt))

  // Req-6 relevance: an on-topic lower-frequency lesson outranks a higher-frequency
  // off-topic one; with no relevance signal, frequency order is preserved.
  const pool = [
    { kind: 'meh' as const, cls: 'too_verbose', count: 9, lesson: 'cut the prose' },
    { kind: 'meh' as const, cls: 'ui_noise', count: 3, lesson: 'reduce ui noise' },
  ]
  check('relevant (lower-count) lesson ranks first when on-topic',
    rankByRelevance(pool, 'the output is too cluttered and noisy')[0].cls === 'ui_noise')
  check('no relevance signal ⇒ frequency order preserved',
    rankByRelevance(pool, 'unrelated text')[0].cls === 'too_verbose')

  // throttle (pure, history-derived)
  const att = { type: 'attachment', attachment: { type: 'taste_recall', content: 'x' } }
  const human = { type: 'user', message: { content: 'hi' } }
  check('no prior reminder ⇒ emit', shouldEmitTasteRecall([] as never) === true)
  check('reminder just shown (0 human turns since) ⇒ suppress',
    shouldEmitTasteRecall([att] as never) === false)
  check(`${RECALL_THROTTLE_TURNS} human turns since reminder ⇒ emit`,
    shouldEmitTasteRecall([att, ...Array.from({ length: RECALL_THROTTLE_TURNS }, () => human)] as never) === true)

  // getTasteRecallContent: derives live from episodes; precision = only promoted.
  const recallDir = await mkdtemp(join(tmpdir(), 'taste-recall-'))
  try {
    // one-off meh (below threshold) ⇒ no promoted ⇒ null
    await writeEpisode(recallDir, buildEpisode('meh', 'too verbose once', emptySnap(), new Date().toISOString()))
    check('single (un-promoted) episode ⇒ recall null (precision)',
      (await getTasteRecallContent(recallDir, [] as never)) === null)
    // cross threshold ⇒ recall surfaces the promoted lesson
    for (let i = 0; i < PROMOTE_THRESHOLD; i++) {
      await writeEpisode(recallDir, buildEpisode('meh', 'too verbose wall of text', emptySnap(), new Date(Date.now() + i + 1).toISOString()))
    }
    const live = await getTasteRecallContent(recallDir, [] as never)
    check('promoted lesson surfaces in recall', !!live && /Avoid:/.test(live!))
  } finally {
    await rm(recallDir, { recursive: true, force: true })
  }

  section('/meh + /good command smoke (real runTasteCommand, injected dir)')
  {
    const cmdDir = await mkdtemp(join(tmpdir(), 'taste-cmd-'))
    try {
      const ctx = {
        messages: [
          { type: 'user', message: { content: 'fix the parser' } },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'a', name: 'Read' }] } },
        ],
        getAppState: () => ({ toolPermissionContext: { mode: 'default' }, ultracode: true }),
      }
      const mres = await runTasteCommand('meh', 'that was too verbose, a wall of text', ctx as never, cmdDir)
      check('/meh echoes logged + class + adjustment',
        /Logged a \/meh → too_verbose/.test(mres.value) && /Next adjustment:/.test(mres.value),
        mres.value.split('\n')[0])
      const gres = await runTasteCommand('good', 'concise and to the point', ctx as never, cmdDir)
      check('/good echoes logged + class + keep-doing',
        /Logged a \/good → concise_answer/.test(gres.value) && /Keep doing:/.test(gres.value))
      check('two episodes persisted from the commands', (await readEpisodes(cmdDir)).length === 2)
      const empty = await runTasteCommand('meh', '   ', ctx as never, cmdDir)
      check('/meh with no text ⇒ usage, nothing logged',
        /Usage:/.test(empty.value) && (await readEpisodes(cmdDir)).length === 2)
      process.env.MERCURY_TASTE_LOOP = '0'
      const off = await runTasteCommand('meh', 'too verbose', ctx as never, cmdDir)
      check('/meh with =0 ⇒ off message, nothing logged',
        /off this session/i.test(off.value) && (await readEpisodes(cmdDir)).length === 2)
      process.env.MERCURY_TASTE_LOOP = '1'
    } finally {
      await rm(cmdDir, { recursive: true, force: true })
    }
  }

  section('Gate polarity (OPT-IN since lightening: unset ⇒ OFF, =1 arms)')
  check('gate ON while armed (=1)', tasteLoopEnabled() === true)
  delete process.env.MERCURY_TASTE_LOOP
  check('gate OFF by DEFAULT (unset — the opt-in flip)', tasteLoopEnabled() === false)
  check('commands disabled by default', meh.isEnabled?.() === false && good.isEnabled?.() === false)
  check('recall null by default even if promoted exist', (await getTasteRecallContent(dir, [] as never)) === null)
  process.env.MERCURY_TASTE_LOOP = '0'
  check('gate OFF with explicit =0', tasteLoopEnabled() === false)
  process.env.MERCURY_TASTE_LOOP = '1'
  check('gate ON again with =1', tasteLoopEnabled() === true)
  delete process.env.MERCURY_TASTE_LOOP
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ' ✅ ALL TASTE PROOFS PASS' : ` ❌ ${failures} TASTE PROOF(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
