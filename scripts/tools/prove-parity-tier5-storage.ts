#!/usr/bin/env bun
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const t = (name: string, ok: boolean, detail = '', failHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && failHint ? ` — ${failHint}` : ''}`)
  if (!ok) failures = 1
}

const scratchHome = mkdtempSync(join(tmpdir(), 'parity-t5-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const underscore = getProjectDir('/tmp/parity-proj_x')
const hyphen = getProjectDir('/tmp/parity-proj-x')
const dot = getProjectDir('/tmp/parity-proj.x')
t(
  'punctuation siblings resolve to distinct transcript directories',
  new Set([underscore, hyphen, dot]).size === 3,
  [underscore, hyphen, dot].join(' · '),
  'Make getProjectDir in src/sessions/transcripts/paths.ts give paths that differ only in punctuation (underscore, hyphen, dot) their own directories.',
)
const { getProjectDir: resolveProjectDir, projectSlug, sanitizePath } = await import(
  '../../src/sessions/transcripts/sessionStoragePortable.ts'
)
const hashlessWithTranscript = join(scratchHome, 'projects', sanitizePath('/tmp/parity-hashless_proj'))
mkdirSync(hashlessWithTranscript, { recursive: true })
writeFileSync(join(hashlessWithTranscript, 'parity-hashless.jsonl'), '{}\n')
t(
  'a hash-less directory holding a transcript is not read — the hashed store is the store',
  resolveProjectDir('/tmp/parity-hashless_proj') !== hashlessWithTranscript && resolveProjectDir('/tmp/parity-hashless_proj').endsWith(projectSlug('/tmp/parity-hashless_proj')),
  '',
  'Make getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts return the hashed projectSlug directory and never a hash-less sanitizePath directory, even when that one holds a transcript.',
)
const bareDir = join(scratchHome, 'projects', sanitizePath('/tmp/parity-bare_proj'))
mkdirSync(bareDir, { recursive: true })
t(
  'a BARE hash-less directory (no transcript inside) is not read either — the hashed store wins (FC-007)',
  resolveProjectDir('/tmp/parity-bare_proj') !== bareDir,
  '',
  'Make getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts skip an empty hash-less sanitizePath directory and return the hashed projectSlug directory.',
)

const { parseFrontmatter, FRONTMATTER_REGEX } = await import(
  '../../src/platform/text/frontmatterParser.ts'
)
const bomDoc = '\uFEFF---\ndescription: parity probe\n---\n\nbody text\n'
const parsed = parseFrontmatter(bomDoc)
t(
  'a BOM-prefixed .md still yields its frontmatter',
  parsed.frontmatter.description === 'parity probe',
  JSON.stringify(parsed.frontmatter),
  'Make parseFrontmatter and FRONTMATTER_REGEX in src/platform/text/frontmatterParser.ts accept a leading BOM before the opening ---.',
)
t('the exported recognizer consumes the BOM with the block', FRONTMATTER_REGEX.test(bomDoc), '', 'Let FRONTMATTER_REGEX in src/platform/text/frontmatterParser.ts match a leading BOM with the block.')
const plainDoc = '---\ndescription: still fine\n---\n\nbody\n'
t(
  'a BOM-less .md parses unchanged',
  parseFrontmatter(plainDoc).frontmatter.description === 'still fine',
  '',
  'Keep parseFrontmatter in src/platform/text/frontmatterParser.ts parsing a document with no BOM as before.',
)

const { checkCrossProjectResume } = await import('../../src/screen/session-chooser/crossProjectResume.ts')
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
  '',
  'Make checkCrossProjectResume in src/screen/session-chooser/crossProjectResume.ts return isCrossProject true with a --resume command for a directory that exists.',
)
const deadVerdict = checkCrossProjectResume(logFor(deadDir), true, [])
t(
  'a deleted directory resumes in place — no dead cd instruction',
  (deadVerdict as { isCrossProject: boolean }).isCrossProject === false,
  '',
  'Make checkCrossProjectResume in src/screen/session-chooser/crossProjectResume.ts return isCrossProject false for a project directory that no longer exists.',
)

rmSync(scratchHome, { recursive: true, force: true })
rmSync(liveDir, { recursive: true, force: true })
process.exit(failures)
