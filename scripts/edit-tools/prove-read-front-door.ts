#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-read-front-door.ts — the read front door,
//  proved against the PRODUCTION FileReadTool with real fs fixtures.
//
//  Laws:
//    C. classification is string-only and total — mercury:// ⇒ resource,
//       http(s):// ⇒ url (case-insensitive), everything else ⇒ file
//    F. flag OFF ⇒ the plain Read byte-identically — prompt keeps the exact
//       "not directories → Bash ls" line, description has no suffix, a
//       directory target errors exactly like the baseline surface
//    D. directories (ON) — machine header line · byte-order sort (locale
//       never consulted) · '/' suffix on dirs · deterministic across calls ·
//       hard cap with NAMED omissions + a precise Glob next action ·
//       readFileState never records a directory (no duplicate attachments)
//    R. resources (ON) — served through the EXISTING registry with explicit
//       typed states (absent/unavailable named, never optimistic prose);
//       unknown kinds answer with the known-kind list
//    U. urls (ON) — a typed delegation NAMING the exact WebFetch call;
//       Read performs no fetch (the renderer is synchronous and inert)
//    M. missing/odd file targets (ON) — identical behaviour to OFF (the
//       router only claims targets that error today)
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-read-front-door.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anvil-s1-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_READ_TARGETS

const {
  classifyReadTarget,
  renderDirectoryTarget,
  renderUrlDelegation,
  DIRECTORY_ENTRY_CAP,
} = await import('../../src/tools/FileReadTool/readTarget.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — front-door proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

type ReadStamp = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }
function makeContext(readFileState: Map<string, ReadStamp>) {
  return {
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never
}

async function readViaTool(
  path: string,
  ctx: ReturnType<typeof makeContext>,
  extra: Record<string, unknown> = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const result = await (FileReadTool as { call: Function }).call(
      { file_path: path, ...extra },
      ctx,
      null,
      { uuid: '00000000-0000-0000-0000-000000000001', message: { id: 'msg_fixture' } },
    )
    const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function })
      .mapToolResultToToolResultBlockParam(result.data, 'toolu_read')
    return { ok: true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const fixtures = mkdtempSync(join(tmpdir(), 'anvil-s1-fixture-'))
const dirTarget = join(fixtures, 'listing')
mkdirSync(join(dirTarget, 'zeta'), { recursive: true })
mkdirSync(join(dirTarget, 'Alpha'))
writeFileSync(join(dirTarget, 'B.txt'), 'b\n')
writeFileSync(join(dirTarget, 'a.txt'), 'a\n')
const textFile = join(fixtures, 'plain.txt')
writeFileSync(textFile, 'one\ntwo\nthree\n')
const bigDir = join(fixtures, 'big')
mkdirSync(bigDir)
for (let i = 0; i < DIRECTORY_ENTRY_CAP + 5; i++) {
  writeFileSync(join(bigDir, `f${String(i).padStart(4, '0')}.txt`), 'x')
}

// ── C. classification ───────────────────────────────────────────────────────
section('C. classification is string-only and total')
{
  check('C1 mercury:// ⇒ resource', classifyReadTarget('mercury://doctor/latest').kind === 'resource')
  check('C2 https ⇒ url', classifyReadTarget('https://example.com/x').kind === 'url')
  check('C3 http mixed case ⇒ url', classifyReadTarget('HTTP://example.com').kind === 'url')
  check('C4 plain path ⇒ file', classifyReadTarget('/tmp/x.txt').kind === 'file')
  check('C5 relative path ⇒ file', classifyReadTarget('src/x.ts').kind === 'file')
  check('C6 a path CONTAINING http stays file', classifyReadTarget('/notes/https-thing.md').kind === 'file')
}

// ── F. flag OFF ⇒ the plain surface ─────────────────────────────────────────────
section('F. OFF ⇒ byte-identical plain Read')
{
  process.env.MERCURY_READ_TARGETS = '0'
  const prompt = await (FileReadTool as { prompt: Function }).prompt()
  check('F1 no-directories line present', prompt.includes('reads files, never directories'))
  check('F2 no front-door lines', !prompt.includes('mercury:// resource references'))
  const desc = await (FileReadTool as { description: Function }).description()
  check('F3 description has no front-door suffix', !desc.includes('bounded listing'))
  const offDir = await readViaTool(dirTarget, makeContext(new Map()))
  check('F4 directory read still errors OFF', !offDir.ok)
  const offRes = await readViaTool('mercury://doctor/latest', makeContext(new Map()))
  check('F5 mercury:// read still errors OFF', !offRes.ok)
}

// ── D. directories ON ───────────────────────────────────────────────────────
section('D. directory targets — deterministic bounded listing')
{
  process.env.MERCURY_READ_TARGETS = '1'
  const prompt = await (FileReadTool as { prompt: Function }).prompt()
  check('D0 front-door prompt lines ON', prompt.includes('deterministic bounded listing') && !prompt.includes('reads files, never directories'))
  const state = new Map<string, ReadStamp>()
  const r1 = await readViaTool(dirTarget, makeContext(state))
  check('D1 directory resolves ON', r1.ok)
  if (r1.ok) {
    check('D2 machine header line', r1.text.includes('(target: directory · owner: Read · entries: 4 shown of 4)'))
    const alpha = r1.text.indexOf('Alpha/')
    const bTxt = r1.text.indexOf('B.txt')
    const aTxt = r1.text.indexOf('a.txt')
    const zeta = r1.text.indexOf('zeta/')
    check('D3 byte-order sort (Alpha < B.txt < a.txt < zeta)', alpha >= 0 && bTxt > alpha && aTxt > bTxt && zeta > aTxt)
    check('D4 dirs suffixed /', r1.text.includes('Alpha/') && r1.text.includes('zeta/'))
  }
  const r2 = await readViaTool(dirTarget, makeContext(new Map()))
  check('D5 deterministic across calls', r1.ok && r2.ok && r1.text === r2.text)
  check('D6 readFileState never records a directory', !state.has(dirTarget))
  const big = await readViaTool(bigDir, makeContext(new Map()))
  check('D7 cap enforced with NAMED omissions', big.ok && big.text.includes(`entries: ${DIRECTORY_ENTRY_CAP} shown of ${DIRECTORY_ENTRY_CAP + 5}`) && big.text.includes('5 more entries omitted'))
  check('D8 overflow names the Glob next action', big.ok && big.text.includes('Glob(pattern:'))
  const rendered = renderDirectoryTarget(join(fixtures, 'nope-dir'))
  check('D9 unreadable directory names unavailable', rendered.content.includes('state: unavailable'))
}

// ── R. resources ON ─────────────────────────────────────────────────────────
section('R. resource targets — typed states through the ONE registry')
{
  const absent = await readViaTool('mercury://doctor/latest', makeContext(new Map()))
  check('R1 doctor/latest resolves with explicit state', absent.ok && /state: (ok|absent|unavailable)/.test(absent.text))
  const unknown = await readViaTool('mercury://nokind/x', makeContext(new Map()))
  check('R2 unknown kind names the known kinds', unknown.ok && unknown.text.includes('state: absent') && unknown.text.includes('known kinds:'))
}

// ── U. urls ON ──────────────────────────────────────────────────────────────
section('U. url targets — typed delegation, never a fetch')
{
  const u = await readViaTool('https://example.com/doc.html', makeContext(new Map()))
  check('U1 delegation header', u.ok && u.text.includes('(target: url · owner: WebFetch · state: delegated)'))
  check('U2 names the exact next call', u.ok && u.text.includes('call WebFetch with url: https://example.com/doc.html'))
  const rendered = renderUrlDelegation('  https://x.dev/a  ')
  check('U3 renderer is inert + trims', rendered.content.includes('url: https://x.dev/a'))
}

// ── M. file behaviour unchanged ON ──────────────────────────────────────────
section('M. file targets byte-identical ON vs OFF')
{
  const on = await readViaTool(textFile, makeContext(new Map()))
  const onRange = await readViaTool(textFile, makeContext(new Map()), { offset: 2, limit: 1 })
  process.env.MERCURY_READ_TARGETS = '0'
  const off = await readViaTool(textFile, makeContext(new Map()))
  const offRange = await readViaTool(textFile, makeContext(new Map()), { offset: 2, limit: 1 })
  check('M1 full read identical', on.ok && off.ok && on.text === off.text)
  check('M2 ranged read identical', onRange.ok && offRange.ok && onRange.text === offRange.text)
  process.env.MERCURY_READ_TARGETS = '1'
  const missOn = await readViaTool(join(fixtures, 'ghost.txt'), makeContext(new Map()))
  process.env.MERCURY_READ_TARGETS = '0'
  const missOff = await readViaTool(join(fixtures, 'ghost.txt'), makeContext(new Map()))
  check('M3 missing file error identical', !missOn.ok && !missOff.ok && missOn.error === missOff.error)
  process.env.MERCURY_READ_TARGETS = '1'
}

console.log('')
if (failures > 0) {
  console.error(`prove-read-front-door: ${failures} RED`)
  process.exit(1)
}
console.log('prove-read-front-door: GREEN')
