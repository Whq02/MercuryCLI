#!/usr/bin/env bun
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const scratchHome = mkdtempSync(join(tmpdir(), 'parity-t5-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const underscore = getProjectDir('/tmp/parity-proj_x')
const hyphen = getProjectDir('/tmp/parity-proj-x')
const dot = getProjectDir('/tmp/parity-proj.x')
t(
  'punctuation siblings resolve to distinct transcript directories',
  new Set([underscore, hyphen, dot]).size === 3,
  `${[underscore, hyphen, dot].join(' · ')}\nHint: getProjectDir in src/utils/sessionStorage/paths.ts must give paths that differ only by punctuation their own directories.`,
)
const { getProjectDir: resolveProjectDir, projectSlug, sanitizePath } = await import(
  '../../src/utils/sessionStoragePortable.ts'
)
const hashlessWithTranscript = join(scratchHome, 'projects', sanitizePath('/tmp/parity-hashless_proj'))
mkdirSync(hashlessWithTranscript, { recursive: true })
writeFileSync(join(hashlessWithTranscript, 'parity-hashless.jsonl'), '{}\n')
t(
  'a hash-less directory holding a transcript is not read — the hashed store is the store',
  resolveProjectDir('/tmp/parity-hashless_proj') !== hashlessWithTranscript && resolveProjectDir('/tmp/parity-hashless_proj').endsWith(projectSlug('/tmp/parity-hashless_proj')),
  'Hint: getProjectDir in src/utils/sessionStoragePortable.ts must return the hashed directory (projectSlug) even when a hash-less directory holds a transcript.',
)
const bareDir = join(scratchHome, 'projects', sanitizePath('/tmp/parity-bare_proj'))
mkdirSync(bareDir, { recursive: true })
t(
  'a BARE hash-less directory (no transcript inside) is not read either — the hashed store wins (FC-007)',
  resolveProjectDir('/tmp/parity-bare_proj') !== bareDir,
  'Hint: getProjectDir in src/utils/sessionStoragePortable.ts must return the hashed directory (projectSlug) even when an empty hash-less directory exists.',
)

const { parseFrontmatter, FRONTMATTER_REGEX } = await import(
  '../../src/utils/frontmatterParser.ts'
)
const bomDoc = '\uFEFF---\ndescription: parity probe\n---\n\nbody text\n'
const parsed = parseFrontmatter(bomDoc)
t(
  'a BOM-prefixed .md still yields its frontmatter',
  parsed.frontmatter.description === 'parity probe',
  `${JSON.stringify(parsed.frontmatter)}\nHint: parseFrontmatter and FRONTMATTER_REGEX in src/utils/frontmatterParser.ts must accept a leading BOM before the opening ---.`,
)
t('the exported recognizer consumes the BOM with the block', FRONTMATTER_REGEX.test(bomDoc), 'Hint: FRONTMATTER_REGEX in src/utils/frontmatterParser.ts must consume a leading BOM together with the block.')
const plainDoc = '---\ndescription: still fine\n---\n\nbody\n'
t(
  'a BOM-less .md parses unchanged',
  parseFrontmatter(plainDoc).frontmatter.description === 'still fine',
  'Hint: parseFrontmatter in src/utils/frontmatterParser.ts must still parse a document with no BOM.',
)

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
  'Hint: checkCrossProjectResume in src/utils/crossProjectResume.ts must report a cross-project resume with a --resume command for a directory that exists.',
)
const deadVerdict = checkCrossProjectResume(logFor(deadDir), true, [])
t(
  'a deleted directory resumes in place — no dead cd instruction',
  (deadVerdict as { isCrossProject: boolean }).isCrossProject === false,
  'Hint: checkCrossProjectResume in src/utils/crossProjectResume.ts must not report a cross-project resume for a directory that no longer exists.',
)

rmSync(scratchHome, { recursive: true, force: true })
rmSync(liveDir, { recursive: true, force: true })
process.exit(failures)
