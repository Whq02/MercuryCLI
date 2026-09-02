#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-instruction-capture.ts — the ONE shared writer
//  behind organic MERCURY.md capture.
//
//  Laws pinned, each on its own scratch fixture (scratch config home; no
//  operator state touched):
//    · ONE WRITE SHAPE — the writer function, /remember's `project:` scope,
//      and the RecordConvention tool produce byte-identical estates from the
//      same fixture (the two capture seams share the one writer).
//    · THE POINTER LAW — a thin MERCURY.md pointing at AGENTS.md lands the
//      rule in AGENTS.md and leaves the pointer byte-untouched; a
//      SUBSTANTIVE entry with an import keeps the rule at the entry; a
//      pointer cycle terminates.
//    · MERGE, NEVER DUPLICATE — an exact restatement is a no-op; `replaces`
//      swaps the named line in place; a replace with no match writes
//      nothing and says so.
//    · ORGANIC BIRTH — a repo with no estate gets a minimal MERCURY.md born
//      with the first rule (the second birth path beside /init).
//
//  Run: ~/.bun/bin/bun run scripts/self-hosting/prove-instruction-capture.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Scratch config home BEFORE any product import (settings/config hygiene).
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cap-home-'))
process.env.MERCURY_EVOLUTION_LEDGER = '0'

const repo = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import(`${repo}/src/utils/config/globalConfig.js`)
enableConfigs()
const writer = await import(`${repo}/src/services/instructions/projectInstructionWriter.js`)
const { runWithCwdOverride } = await import(`${repo}/src/utils/cwd.js`)
const { call: rememberCall } = await import(`${repo}/src/commands/remember/remember.js`)
const { RecordConventionTool } = await import(
  `${repo}/src/tools/RecordConventionTool/RecordConventionTool.js`
)

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

const POINTER = '@AGENTS.md\nThe guide is AGENTS.md; this file only points at it.\n'
const GUIDE = '# Guide\n\nBuild with bun.\n'
function pointerFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cap-fix-'))
  execSync('git init -q', { cwd: dir })
  writeFileSync(join(dir, 'MERCURY.md'), POINTER)
  writeFileSync(join(dir, 'AGENTS.md'), GUIDE)
  return dir
}
const RULE = 'always use bun here'

// ── one write shape across the three seams ─────────────────────────────────
console.log('one write shape — writer fn · /remember project scope · RecordConvention tool')
const viaFn = pointerFixture()
const r1 = writer.captureProjectInstruction({ cwd: viaFn, rule: RULE })
check(r1.action === 'recorded' && !r1.created, 'writer fn records into the existing estate', JSON.stringify(r1))

const viaCmd = pointerFixture()
const cmdRes = await runWithCwdOverride(viaCmd, () => rememberCall(`project: ${RULE}`, {} as never))
check(
  cmdRes.type === 'text' && /Recorded in AGENTS\.md/.test(cmdRes.value),
  '/remember project: reports the pointed guide',
  JSON.stringify(cmdRes),
)

const viaTool = pointerFixture()
const toolRes = await runWithCwdOverride(viaTool, () =>
  RecordConventionTool.call({ rule: RULE }, {} as never, undefined as never, undefined as never),
)
check(
  (toolRes as { data: { action: string } }).data.action === 'recorded',
  'RecordConvention tool records',
  JSON.stringify(toolRes),
)

const agentsBytes = readFileSync(join(viaFn, 'AGENTS.md'), 'utf8')
check(
  agentsBytes === readFileSync(join(viaCmd, 'AGENTS.md'), 'utf8') &&
    agentsBytes === readFileSync(join(viaTool, 'AGENTS.md'), 'utf8'),
  'all three seams produce byte-identical guides (ONE writer)',
)
check(
  readFileSync(join(viaFn, 'MERCURY.md'), 'utf8') === POINTER &&
    readFileSync(join(viaCmd, 'MERCURY.md'), 'utf8') === POINTER &&
    readFileSync(join(viaTool, 'MERCURY.md'), 'utf8') === POINTER,
  'the pointer file stays byte-untouched on every seam',
)
check(
  agentsBytes === `# Guide\n\nBuild with bun.\n\n- ${RULE}\n`,
  'the write shape: one bullet, one blank line of separation',
  JSON.stringify(agentsBytes),
)

// ── merge, never duplicate ─────────────────────────────────────────────────
console.log('merge, never duplicate')
const r2 = writer.captureProjectInstruction({ cwd: viaFn, rule: 'Always use bun here.' })
check(r2.action === 'already-recorded', 'an exact restatement (case/period aside) is a no-op', JSON.stringify(r2))
check(
  readFileSync(join(viaFn, 'AGENTS.md'), 'utf8') === agentsBytes,
  'the no-op writes nothing',
)
const r3 = writer.captureProjectInstruction({
  cwd: viaFn,
  rule: 'always use bun 1.3 here',
  replaces: 'always use bun here',
})
check(r3.action === 'updated', '`replaces` merges in place', JSON.stringify(r3))
check(
  readFileSync(join(viaFn, 'AGENTS.md'), 'utf8') === `# Guide\n\nBuild with bun.\n\n- always use bun 1.3 here\n`,
  'the old line is swapped, not appended beside',
)
const r4 = writer.captureProjectInstruction({
  cwd: viaFn,
  rule: 'x',
  replaces: 'no such rule anywhere',
})
check(r4.action === 'replace-miss', 'a replace with no match refuses honestly', JSON.stringify(r4))

// ── organic birth ──────────────────────────────────────────────────────────
console.log('organic birth')
const virgin = mkdtempSync(join(tmpdir(), 'cap-virgin-'))
execSync('git init -q', { cwd: virgin })
const r5 = writer.captureProjectInstruction({ cwd: virgin, rule: 'never touch the vendored dir' })
check(r5.action === 'recorded' && r5.created === true, 'a repo with no estate births the entry', JSON.stringify(r5))
check(
  readFileSync(join(virgin, 'MERCURY.md'), 'utf8') ===
    '# MERCURY.md\nStanding orders for the Mercury harness in this repository.\n\n- never touch the vendored dir\n',
  'the born entry: two-line header + the rule',
)

// ── substantive entry keeps the rule at the entry ──────────────────────────
console.log('substantive entry (imports present, but not a pointer)')
const subst = mkdtempSync(join(tmpdir(), 'cap-subst-'))
execSync('git init -q', { cwd: subst })
const prose = Array.from({ length: 10 }, (_, i) => `Substantive rule line ${i}.`).join('\n')
writeFileSync(join(subst, 'MERCURY.md'), `# P\n\n@EXTRA.md\n${prose}\n`)
writeFileSync(join(subst, 'EXTRA.md'), '# extra\n')
const r6 = writer.captureProjectInstruction({ cwd: subst, rule: 'tests run with the wrapper script' })
check(
  r6.action === 'recorded' && r6.path === join(subst, 'MERCURY.md'),
  'a substantive entry receives the rule itself',
  JSON.stringify(r6),
)
check(
  readFileSync(join(subst, 'EXTRA.md'), 'utf8') === '# extra\n',
  'the imported side-file stays untouched',
)

// ── pointer cycle terminates ───────────────────────────────────────────────
console.log('pointer cycle')
const cyc = mkdtempSync(join(tmpdir(), 'cap-cycle-'))
execSync('git init -q', { cwd: cyc })
writeFileSync(join(cyc, 'MERCURY.md'), '@A.md\npointer.\n')
writeFileSync(join(cyc, 'A.md'), '@MERCURY.md\nback.\n')
const r7 = writer.captureProjectInstruction({ cwd: cyc, rule: 'cycle-safe rule' })
check(
  r7.action === 'recorded' && r7.path === join(cyc, 'A.md'),
  'a pointer cycle stops at the visited set (rule lands one hop in)',
  JSON.stringify(r7),
)

// ── the dedup sees the whole loaded estate ─────────────────────────────────
console.log('estate-wide dedup')
const r8 = writer.captureProjectInstruction({ cwd: viaCmd, rule: 'Build with bun.' })
check(
  r8.action === 'already-recorded',
  'a rule already stated in the pointed guide is not re-recorded from the entry',
  JSON.stringify(r8),
)

check(existsSync(join(virgin, 'MERCURY.md')), 'fixtures on disk where expected (sanity)')

// ── C15 (BOM class): a BOM-led instruction file parses whole ────────────────
// A UTF-8 BOM (Windows Notepad's default) broke every position-0 grammar in
// the parser — frontmatter undetected, so it leaked into the composed
// content — and rode into the digest, so the engine's dedupe told BOM'd and
// clean copies of one file apart. The parser now strips before any parse.
console.log('BOM-led instruction files')
{
  const { parseInstructionFileContent } = await import(`${repo}/src/services/instructions/sourceText.js`)
  const body = '---\ntitle: x\n---\nThe rule stands.\n'
  const clean = parseInstructionFileContent(body, join(virgin, 'MERCURY.md'), 'Project')
  const bommed = parseInstructionFileContent(String.fromCharCode(0xfeff) + body, join(virgin, 'MERCURY.md'), 'Project')
  check(
    clean.info !== null && bommed.info !== null && bommed.info.content === clean.info.content,
    'a BOM-led file composes byte-identically to its clean twin (frontmatter detected, BOM stripped, digests agree)',
    JSON.stringify({ clean: clean.info?.content?.slice(0, 40), bommed: bommed.info?.content?.slice(0, 40) }),
  )
  check(
    bommed.info !== null && !bommed.info.content.includes('---'),
    "…and the BOM'd frontmatter never leaks into the composed content",
    bommed.info?.content?.slice(0, 60),
  )
}

console.log(failures === 0 ? '\nALL CAPTURE LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
