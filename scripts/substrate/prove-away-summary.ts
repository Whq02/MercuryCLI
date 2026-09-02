#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-away-summary.ts
//  PROOF: the away/resume recap ("what happened while you were gone"). On a
//  resumed session the REPL mounts with the prior transcript but nothing tells you
//  its SHAPE — this derives a one-line recap (turns / files touched / top tools /
//  how long ago) from the resumed messages and surfaces it as a resume
//  notification. PURE + deterministic (nowMs injected) so this is a LIVE proof.
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-away-summary.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const { isAwaySummaryEnabled, buildAwaySummary, buildAwayRecap } = await import(
  '../../src/utils/cockpit/awaySummary.js'
)

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (m: any[], now = NOW, git?: any) => buildAwaySummary(m as any, now, git)
let seq = 0
const uid = () => `u-${seq++}`
const ts = (iso: string) => iso
function userTurn(text: string, when: string) {
  return { type: 'user', uuid: uid(), timestamp: ts(when), message: { role: 'user', content: [{ type: 'text', text }] } }
}
function toolResultMsg(when: string) {
  return { type: 'user', uuid: uid(), timestamp: ts(when), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }
}
function asst(when: string, uses: Array<{ name: string; file?: string }>) {
  return {
    type: 'assistant', uuid: uid(), timestamp: ts(when),
    message: { id: uid(), role: 'assistant', content: uses.map(u => ({ type: 'tool_use', id: uid(), name: u.name, input: u.file ? { file_path: u.file } : {} })) },
  }
}

console.log('============================================================')
console.log(' away/resume recap — what happened while you were gone')
console.log('============================================================')

// ── (a) gate ──────────────────────────────────────────────────────────────────
section('(a) gate — default-ON for fork (substrate), =0 opt-out wins')
{
  delete process.env.MERCURY_AWAY_SUMMARY
  delete process.env.MERCURY_SUBSTRATE
  check('fork default (substrate on) ⇒ enabled', isAwaySummaryEnabled() === true)
  process.env.MERCURY_AWAY_SUMMARY = '0'
  check('MERCURY_AWAY_SUMMARY=0 ⇒ disabled', isAwaySummaryEnabled() === false)
  process.env.MERCURY_AWAY_SUMMARY = 'false'
  check('=false ⇒ disabled', isAwaySummaryEnabled() === false)
  delete process.env.MERCURY_AWAY_SUMMARY
  process.env.MERCURY_SUBSTRATE = '0'
  check('MERCURY_SUBSTRATE=0 (no opt-in) ⇒ disabled (byte-identical)', isAwaySummaryEnabled() === false)
  process.env.MERCURY_AWAY_SUMMARY = '1'
  check('explicit =1 overrides substrate-off', isAwaySummaryEnabled() === true)
  delete process.env.MERCURY_AWAY_SUMMARY
  delete process.env.MERCURY_SUBSTRATE
  ;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '0.0.0-src' }
  // A bare stamp would otherwise disable the recap;
  // there is no version seam — the default is stamp-independent.
  check('bare stamp ⇒ STILL enabled (stamp-independence)', isAwaySummaryEnabled() === true)
  ;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
}

// ── (b) null when nothing to report ─────────────────────────────────────────
section('(b) null when empty / no real turns and no tracked tools')
{
  check('empty ⇒ null', build([]) === null)
  check('only tool_result carriers + meta ⇒ null', build([toolResultMsg('2026-01-01T10:00:00.000Z'), { type: 'user', uuid: uid(), isMeta: true, timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'meta' } }]) === null)
}

// ── (c) the recap content: turns, files, gap, top-3 tools ───────────────────
section('(c) recap derives turns / files / gap / top tools from the messages')
{
  const msgs = [
    userTurn('do X', '2026-01-01T09:00:00.000Z'),
    asst('2026-01-01T09:01:00.000Z', [{ name: 'Edit', file: 'a.ts' }]),
    toolResultMsg('2026-01-01T09:02:00.000Z'), // NOT a turn
    asst('2026-01-01T09:03:00.000Z', [{ name: 'Bash' }]),
    userTurn('now Y', '2026-01-01T09:30:00.000Z'),
    asst('2026-01-01T10:00:00.000Z', [{ name: 'Edit', file: 'b.ts' }, { name: 'Read', file: 'a.ts' }]),
    { type: 'user', uuid: uid(), isMeta: true, timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'meta' } }, // NOT a turn
    { type: 'user', uuid: uid(), isCompactSummary: true, timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'summary' } }, // NOT a turn
  ]
  const out = build(msgs)
  console.log(`       → "${out}"`)
  check('exact recap line', out === 'Resumed — 2 turns, 2 files touched, last active 2h ago · Edit×2 Bash×1 Read×1', String(out))
  check('2 real turns (meta/tool-result/compact-summary excluded)', !!out && out.includes('2 turns'))
  check('2 distinct files (a.ts counted once across Edit+Read)', !!out && out.includes('2 files'))
  check('top tools sorted desc, ties by name (Edit×2 then Bash, Read)', !!out && out.includes('Edit×2 Bash×1 Read×1'))
}

// ── (d) gap formatting buckets ──────────────────────────────────────────────
section('(d) gap formatting — just now / Nm / Nh / Nd')
{
  const one = (lastIso: string) => build([userTurn('x', lastIso), asst(lastIso, [{ name: 'Bash' }])], NOW)
  check('30s ⇒ just now', !!one('2026-01-01T11:59:30.000Z') && one('2026-01-01T11:59:30.000Z')!.includes('last active just now'))
  check('5m ⇒ 5m ago', !!one('2026-01-01T11:55:00.000Z') && one('2026-01-01T11:55:00.000Z')!.includes('last active 5m ago'))
  check('3h ⇒ 3h ago', !!one('2026-01-01T09:00:00.000Z') && one('2026-01-01T09:00:00.000Z')!.includes('last active 3h ago'))
  check('2d ⇒ 2d ago', !!one('2025-12-30T12:00:00.000Z') && one('2025-12-30T12:00:00.000Z')!.includes('last active 2d ago'))
}

// ── (e) singularization + no-files / no-tools shapes ────────────────────────
section('(e) singular forms + partial shapes')
{
  const oneTurn = build([userTurn('only', '2026-01-01T11:00:00.000Z')])
  check('1 turn, no tools ⇒ singular, no tool tail', oneTurn === 'Resumed — 1 turn, last active 1h ago', String(oneTurn))
  const noFiles = build([userTurn('x', '2026-01-01T11:00:00.000Z'), asst('2026-01-01T11:00:00.000Z', [{ name: 'Bash' }])])
  check('tools but no files ⇒ no "files touched" clause', !!noFiles && !noFiles.includes('files touched') && noFiles.includes('Bash×1'))
}

// ── (e2) working-tree delta clause (git diff vs HEAD) ───────────────────────
section('(e2) working-tree delta — "N uncommitted (+X/-Y)" from the git diff')
{
  const base = [userTurn('x', '2026-01-01T11:00:00.000Z'), asst('2026-01-01T11:00:00.000Z', [{ name: 'Edit', file: 'a.ts' }])]
  const withGit = build(base, NOW, { files: 3, added: 340, removed: 85 })
  check('shows "N uncommitted (+X/-Y)"', !!withGit && withGit.includes('3 uncommitted (+340/-85)'), String(withGit))
  check('files=0 ⇒ no uncommitted clause', !build(base, NOW, { files: 0, added: 0, removed: 0 })!.includes('uncommitted'))
  const zeroLines = build(base, NOW, { files: 2, added: 0, removed: 0 })
  check('files>0 but 0/0 lines ⇒ "N uncommitted" with no (+/-)', !!zeroLines && zeroLines.includes('2 uncommitted') && !zeroLines.includes('(+'))
  check('null gitDelta ⇒ no clause (off-git / error)', !build(base, NOW, null)!.includes('uncommitted'))
  check('omitted gitDelta ⇒ no clause (back-compat)', !build(base, NOW)!.includes('uncommitted'))
}

// ── (g) end-state — flag an unrecovered error on the last assistant turn ────
section('(g) end-state — "prior run ended on an error" when the last turn errored')
{
  const errMsg = (when: string, kind: 'api' | 'field') => ({
    type: 'assistant', uuid: uid(), timestamp: when,
    ...(kind === 'api' ? { isApiErrorMessage: true } : { error: { type: 'api_error' } }),
    message: { id: uid(), role: 'assistant', content: [{ type: 'text', text: 'boom' }] },
  })
  const clean = [userTurn('x', '2026-01-01T11:00:00.000Z'), asst('2026-01-01T11:00:00.000Z', [{ name: 'Bash' }])]
  check('clean last turn ⇒ no error flag', !build(clean)!.includes('ended on an error'))
  const api = [userTurn('x', '2026-01-01T11:00:00.000Z'), errMsg('2026-01-01T11:00:00.000Z', 'api')]
  check('isApiErrorMessage last turn ⇒ flagged FIRST', build(api)!.startsWith('Resumed — prior run ended on an error'))
  const field = [userTurn('x', '2026-01-01T11:00:00.000Z'), errMsg('2026-01-01T11:00:00.000Z', 'field')]
  check('error-field last turn ⇒ flagged', build(field)!.includes('prior run ended on an error'))
  const recovered = [userTurn('a', '2026-01-01T10:00:00.000Z'), errMsg('2026-01-01T10:00:00.000Z', 'api'), userTurn('retry', '2026-01-01T11:00:00.000Z'), asst('2026-01-01T11:00:00.000Z', [{ name: 'Bash' }])]
  check('recovered (clean last turn after an earlier error) ⇒ NOT flagged', !build(recovered)!.includes('ended on an error'))
}

// ── (g2) failed tool calls — denied/errored calls are not "touched" files ───
section('(g2) failed tool calls — is_error results excluded from files, surfaced honestly')
{
  // A tool_use whose id is known so the failing result can point back at it.
  const asstWithIds = (when: string, uses: Array<{ id: string; name: string; file?: string }>) => ({
    type: 'assistant', uuid: uid(), timestamp: ts(when),
    message: { id: uid(), role: 'assistant', content: uses.map(u => ({ type: 'tool_use', id: u.id, name: u.name, input: u.file ? { file_path: u.file } : {} })) },
  })
  const result = (when: string, toolUseId: string, isErr: boolean) => ({
    type: 'user', uuid: uid(), timestamp: ts(when),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isErr ? 'Denied.' : 'ok', ...(isErr ? { is_error: true } : {}) }] },
  })
  // Both edits failed (the denied-transcript shape): 0 files touched.
  const bothFailed = [
    userTurn('flip the flag', '2026-01-01T09:00:00.000Z'),
    asstWithIds('2026-01-01T09:01:00.000Z', [{ id: 'td1', name: 'Edit', file: 'a.ts' }]),
    result('2026-01-01T09:02:00.000Z', 'td1', true),
    asstWithIds('2026-01-01T09:03:00.000Z', [{ id: 'te1', name: 'Edit', file: 'b.ts' }]),
    result('2026-01-01T09:04:00.000Z', 'te1', true),
  ]
  const bf = buildAwayRecap(bothFailed as any, NOW)
  check('two failed Edits ⇒ filesTouched 0 (denied/errored edits wrote nothing)', bf?.filesTouched === 0, String(bf?.filesTouched))
  check('two failed Edits ⇒ toolFailures 2', bf?.toolFailures === 2, String(bf?.toolFailures))
  check('line names the failures, no files clause', !!bf && bf.line.includes('2 tool calls failed') && !bf.line.includes('files touched'), String(bf?.line))
  // Mixed: the successful Edit still counts its file; the failed one does not.
  const mixed = [
    userTurn('x', '2026-01-01T09:00:00.000Z'),
    asstWithIds('2026-01-01T09:01:00.000Z', [{ id: 'ok1', name: 'Edit', file: 'good.ts' }, { id: 'no1', name: 'Edit', file: 'bad.ts' }]),
    result('2026-01-01T09:02:00.000Z', 'ok1', false),
    result('2026-01-01T09:02:01.000Z', 'no1', true),
  ]
  const mx = buildAwayRecap(mixed as any, NOW)
  check('mixed ⇒ only the completed Edit touches its file', mx?.filesTouched === 1 && !!mx && mx.line.includes('1 file touched'), String(mx?.line))
  check('mixed ⇒ singular "1 tool call failed"', !!mx && mx.line.includes('1 tool call failed'), String(mx?.line))
  // The SAME file failed once then edited clean: the clean call keeps it counted.
  const retried = [
    userTurn('x', '2026-01-01T09:00:00.000Z'),
    asstWithIds('2026-01-01T09:01:00.000Z', [{ id: 'f1', name: 'Edit', file: 'same.ts' }]),
    result('2026-01-01T09:02:00.000Z', 'f1', true),
    asstWithIds('2026-01-01T09:03:00.000Z', [{ id: 'f2', name: 'Edit', file: 'same.ts' }]),
    result('2026-01-01T09:04:00.000Z', 'f2', false),
  ]
  const rt = buildAwayRecap(retried as any, NOW)
  check('failed-then-clean on one file ⇒ still 1 file touched', rt?.filesTouched === 1, String(rt?.filesTouched))
  // A failed file-less tool (Bash) counts as a failure without touching files.
  const bash = [
    userTurn('x', '2026-01-01T09:00:00.000Z'),
    asstWithIds('2026-01-01T09:01:00.000Z', [{ id: 'b1', name: 'Bash' }]),
    result('2026-01-01T09:02:00.000Z', 'b1', true),
  ]
  const bs = buildAwayRecap(bash as any, NOW)
  check('failed Bash ⇒ toolFailures 1, filesTouched 0', bs?.toolFailures === 1 && bs?.filesTouched === 0)
  // No failures ⇒ no clause, toolFailures 0.
  const cleanRun = buildAwayRecap([userTurn('x', '2026-01-01T09:00:00.000Z'), asst('2026-01-01T09:01:00.000Z', [{ name: 'Bash' }])] as any, NOW)
  check('no is_error results ⇒ toolFailures 0 + no failed clause', cleanRun?.toolFailures === 0 && !cleanRun?.line.includes('failed'))
}

// ── (h) structured recap — buildAwayRecap fields + the thin-wrapper contract ─
section('(h) buildAwayRecap — structured fields + buildAwaySummary stays a thin wrapper')
{
  const errLast = (when: string) => ({
    type: 'assistant', uuid: uid(), timestamp: when, isApiErrorMessage: true,
    message: { id: uid(), role: 'assistant', content: [{ type: 'text', text: 'boom' }] },
  })
  const base = [
    userTurn('x', '2026-01-01T09:00:00.000Z'),
    asst('2026-01-01T10:00:00.000Z', [{ name: 'Edit', file: 'a.ts' }, { name: 'Edit', file: 'b.ts' }, { name: 'Bash' }]),
  ]
  // error tail
  const err = buildAwayRecap([...base, errLast('2026-01-01T11:00:00.000Z')] as any, NOW)
  check('error tail ⇒ endedOnError true', err?.endedOnError === true)
  check('error tail ⇒ line carries the error flag first', !!err && err.line.startsWith('Resumed — prior run ended on an error'))
  // clean tail
  const clean = buildAwayRecap(base as any, NOW)
  check('clean tail ⇒ endedOnError false', clean?.endedOnError === false)
  check('structured counts: turns=1 filesTouched=2', clean?.turns === 1 && clean?.filesTouched === 2)
  check('topTools space-joined desc', clean?.topTools === 'Edit×2 Bash×1', String(clean?.topTools))
  check('lastActiveGapMs = now − last ts (2h)', clean?.lastActiveGapMs === 2 * 3600_000, String(clean?.lastActiveGapMs))
  // no-git: gitDelta omitted ⇒ echoed as undefined, no uncommitted clause
  check('no-git ⇒ recap.gitDelta undefined + no clause', clean?.gitDelta === undefined && !clean?.line.includes('uncommitted'))
  const withGit = buildAwayRecap(base as any, NOW, { files: 3, added: 10, removed: 2 })
  check('git delta echoed back for the caller metadata', withGit?.gitDelta?.files === 3)
  // wrapper contract: buildAwaySummary IS buildAwayRecap().line (incl. null passthrough)
  check('wrapper: line identical', buildAwaySummary(base as any, NOW) === clean?.line)
  check('wrapper: null passthrough on empty', buildAwaySummary([], NOW) === null && buildAwayRecap([], NOW) === null)
  // no-timestamp messages ⇒ gap absent (honest), not 0/NaN
  const noTs = buildAwayRecap([{ type: 'user', uuid: uid(), message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }] as any, NOW)
  check('no parseable timestamp ⇒ lastActiveGapMs absent', noTs !== null && noTs.lastActiveGapMs === undefined)

  // ── resume-time SYNTHETIC SENTINELS must not mask the true tail ──────────
  // deserializeMessagesWithInterruptDetection appends an isMeta "Continue
  // from where you left off." user + a FRESH "No response requested."
  // assistant to an interrupted transcript. Before the fix the
  // recap read that sentinel as the last assistant → the picker said
  // `✕ ended on error` while the card said `✓ resumed clean` (two trust
  // surfaces disagreeing on the SAME session), and the gap read 'just now'.
  const sentinelUser = {
    type: 'user', uuid: uid(), timestamp: '2026-01-01T13:00:00.000Z', isMeta: true,
    message: { role: 'user', content: 'Continue from where you left off.' },
  }
  const sentinelAsst = {
    type: 'assistant', uuid: uid(), timestamp: '2026-01-01T13:00:00.000Z',
    message: { id: uid(), role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
  }
  const masked = buildAwayRecap(
    [...base, errLast('2026-01-01T11:00:00.000Z'), sentinelUser, sentinelAsst] as any,
    NOW,
  )
  check('error tail + resume sentinels ⇒ STILL endedOnError (card agrees with the picker)', masked?.endedOnError === true)
  check('sentinels do not move the last-active clock (gap from the REAL tail, not "just now")', masked?.lastActiveGapMs === NOW - Date.parse('2026-01-01T11:00:00.000Z'), String(masked?.lastActiveGapMs))
  check('sentinel user is not a counted turn', masked?.turns === 1)
  const cleanWithSentinels = buildAwayRecap([...base, sentinelUser, sentinelAsst] as any, NOW)
  check('clean tail + sentinels ⇒ still clean (no false ✕)', cleanWithSentinels?.endedOnError === false)
  // a REAL assistant that merely says the sentinel words mid-run is untouched
  const realSameText = buildAwayRecap(
    [...base, { type: 'assistant', uuid: uid(), timestamp: '2026-01-01T11:30:00.000Z', message: { id: uid(), role: 'assistant', content: [{ type: 'text', text: 'No response requested. Proceeding.' }] } }] as any,
    NOW,
  )
  check('multi-text assistant mentioning the words is NOT treated as synthetic', realSameText?.lastActiveGapMs === NOW - Date.parse('2026-01-01T11:30:00.000Z'))
}

// ── (f) wiring: builder + gate imported + used at the resume-hop owner ──────
// Law 9 repoint: the recap moved from the REPL mount effect to
// hopIntoSession.paintResumeRecap — the hop that resumes a session paints the
// display-only card through the connector (the face never writes records).
section('(f) wiring — the resume hop builds the recap and paints the display card')
{
  const hop = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'switchboard', 'hopIntoSession.ts'), 'utf-8')
  check('the hop imports awaySummary', hop.includes("import('../../utils/cockpit/awaySummary.js')"))
  check(
    'the hop gathers the live working-tree delta (git diff --shortstat vs HEAD)',
    hop.includes("execFileNoThrowWithCwd('git', ['diff', '--shortstat', 'HEAD']"),
  )
  check('the hop gates on isAwaySummaryEnabled()', hop.includes('isAwaySummaryEnabled()'))
  check("the hop builds from the session's records + git delta", /buildAwayRecap\(records, Date\.now\(\), gitDelta\)/.test(hop))
  check('the hop gates on the records actually landing (bounded wait, empty ⇒ no card)', /records\.length === 0\) return/.test(hop))
  // The card REPLACED the 30s toast (trust-cockpit W2c): the recap is a
  // display-only away_summary row through the connector; no notification.
  check('the hop paints the recap as a display row (addDisplayRow + factory)', /addDisplayRow\(createAwaySummaryMessage\(recap\.line, enriched\)/.test(hop))
  check('the hop stamps toolFailures into the card metadata when the prior run had any', /toolFailures: recap\.toolFailures/.test(hop))
  check('recapMetadata reads the cert snapshot at the writer (renderer stays props-pure)', hop.includes('healthCertSnapshot()'))
  check("recapMetadata reads the branch sync at the writer (the connector owns the cwd)", hop.includes('readBranchHeadSync(connector.workspace().cwd)'))
  // The renderer seam: SystemTextMessage routes fork+metadata to ResumeRecapCard,
  // and keeps the plain ※ line otherwise (non-forking / no-metadata byte-identical).
  const stm = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'SystemTextMessage.tsx'), 'utf-8')
 check('SystemTextMessage: recapMetadata ⇒ ResumeRecapCard (unconditional, convergence)', /if \(message\.recapMetadata\)/.test(stm) && stm.includes('<ResumeRecapCard'))
  check('SystemTextMessage: the plain ※ line branch is intact', stm.includes("{'※ '}"))
}

console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL AWAY-SUMMARY PROOFS PASS')
else console.log(`❌ ${fail} AWAY-SUMMARY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
