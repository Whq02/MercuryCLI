#!/usr/bin/env bun
// ============================================================================
//  prove-parity-tier5-storage — frontier-sweep #1, tier 5 mechanisms:
//
//   1. Per-project transcript keys are INJECTIVE for new projects: paths
//      differing only by `_` / `-` / `.` resolve to distinct directories
//      (the bare sanitizer folded them together), while an existing legacy
//      store is adopted in place — the migration-safe posture.
//   2. Frontmatter survives a UTF-8 BOM: agent/skill/command .md files
//      written by Windows editors parse their metadata instead of silently
//      dropping it.
//   3. Cross-project resume of a session whose directory was DELETED
//      resumes in place (no cd-into-a-dead-path instruction); a live
//      foreign directory still gets the command arm.
// ============================================================================
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. transcript-key injectivity + adoption ————————————————————————
const scratchHome = mkdtempSync(join(tmpdir(), 'parity-t5-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const underscore = getProjectDir('/tmp/parity-proj_x')
const hyphen = getProjectDir('/tmp/parity-proj-x')
const dot = getProjectDir('/tmp/parity-proj.x')
t(
  'punctuation siblings resolve to distinct transcript directories',
  new Set([underscore, hyphen, dot]).size === 3,
  [underscore, hyphen, dot].join(' · '),
)
const { getProjectDir: resolveWithAdoption, sanitizePath } = await import(
  '../../src/utils/sessionStoragePortable.ts'
)
const legacyDir = join(scratchHome, 'projects', sanitizePath('/tmp/parity-legacy_proj'))
mkdirSync(legacyDir, { recursive: true })
// The legacy arms demand a REAL store — a transcript inside — never bare
// directory existence (FC-007); the fixture carries one.
writeFileSync(join(legacyDir, 'parity-legacy.jsonl'), '{}\n')
t(
  'an existing legacy store is honoured in place (no orphaned history)',
  resolveWithAdoption('/tmp/parity-legacy_proj') === legacyDir,
)
const bareDir = join(scratchHome, 'projects', sanitizePath('/tmp/parity-bare_proj'))
mkdirSync(bareDir, { recursive: true })
t(
  'a BARE legacy directory (no transcript inside) is NOT adopted — the hashed store wins (FC-007)',
  resolveWithAdoption('/tmp/parity-bare_proj') !== bareDir,
)

// —— 2. BOM-tolerant frontmatter ————————————————————————————————————
const { parseFrontmatter, FRONTMATTER_REGEX } = await import(
  '../../src/utils/frontmatterParser.ts'
)
const bomDoc = '\uFEFF---\ndescription: parity probe\n---\n\nbody text\n'
const parsed = parseFrontmatter(bomDoc)
t(
  'a BOM-prefixed .md still yields its frontmatter',
  parsed.frontmatter.description === 'parity probe',
  JSON.stringify(parsed.frontmatter),
)
t('the exported recognizer consumes the BOM with the block', FRONTMATTER_REGEX.test(bomDoc))
const plainDoc = '---\ndescription: still fine\n---\n\nbody\n'
t(
  'a BOM-less .md parses unchanged',
  parseFrontmatter(plainDoc).frontmatter.description === 'still fine',
)

// —— 3. deleted-directory resume ————————————————————————————————————
const { checkCrossProjectResume } = await import('../../src/utils/crossProjectResume.ts')
const liveDir = mkdtempSync(join(tmpdir(), 'parity-t5-live-'))
const deadDir = mkdtempSync(join(tmpdir(), 'parity-t5-dead-'))
rmSync(deadDir, { recursive: true, force: true })
const logFor = (projectPath: string) =>
  ({ projectPath, sessionId: '00000000-0000-4000-8000-000000000042' }) as never
const liveVerdict = checkCrossProjectResume(logFor(liveDir), true, [])
t(
  'a live foreign directory still gets the command arm',
  (liveVerdict as { isCrossProject: boolean }).isCrossProject === true &&
    /--resume/.test((liveVerdict as { command?: string }).command ?? ''),
)
const deadVerdict = checkCrossProjectResume(logFor(deadDir), true, [])
t(
  'a deleted directory resumes in place — no dead cd instruction',
  (deadVerdict as { isCrossProject: boolean }).isCrossProject === false,
)

rmSync(scratchHome, { recursive: true, force: true })
rmSync(liveDir, { recursive: true, force: true })
process.exit(failures)
