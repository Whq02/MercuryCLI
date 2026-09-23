#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'instr-utf16-home-')))
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'instr-utf16-root-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const launchDir = process.cwd()

const discovery = await import('../../src/services/instructions/discovery.ts')
const engine = await import('../../src/services/instructions/engine.ts')
const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const encodings: Array<[string, (text: string) => Buffer]> = [
  ['UTF-8', text => Buffer.from(text, 'utf8')],
  ['UTF-8 BOM', text => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])],
  ['UTF-16LE', text => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
]
const endings: Array<[string, string]> = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]
const GUIDE = ['---', 'paths: src/app.ts', '---', '# Rules', '', 'Use tabs in TypeScript.', 'See @./extra.md for the rest.', '']
const BODY = GUIDE.slice(3)
const EXTRA = 'THE-EXTRA-SENTENCE lives here.\n'
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

function guideFixture(name: string, bytes: Buffer): { dir: string; file: string } {
  const dir = join(ROOT, slug(name))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'MERCURY.md')
  writeFileSync(file, bytes)
  writeFileSync(join(dir, 'extra.md'), EXTRA)
  return { dir, file }
}

section('§1 safelyReadInstructionFileAsync decodes by the byte order mark, as the file tools do')
for (const [eolLabel, eol] of endings) {
  const expected = BODY.join(eol)
  for (const [encLabel, encode] of encodings) {
    const label = `${encLabel} ${eolLabel}${encLabel === 'UTF-8' ? ' (control)' : ''}`
    const { dir, file } = guideFixture(`read ${encLabel} ${eolLabel}`, encode(GUIDE.join(eol)))
    const read = await discovery.safelyReadInstructionFileAsync(file, 'Project', file)
    const content = read.info?.content ?? ''
    check(`${label}: the composed text is the guide body`, content === expected, JSON.stringify(content.slice(0, 48)))
    check(
      `${label}: no NUL and no U+FFFD reach the prompt`,
      read.info !== null && !content.includes('\u0000') && !content.includes('\uFFFD'),
      JSON.stringify(content.slice(0, 24)),
    )
    check(`${label}: the frontmatter paths are read`, JSON.stringify(read.info?.globs) === JSON.stringify(['src/app.ts']), JSON.stringify(read.info?.globs))
    check(
      `${label}: the @include is seen`,
      JSON.stringify(read.includePaths.map(p => relative(dir, p))) === JSON.stringify(['extra.md']),
      JSON.stringify(read.includePaths),
    )
  }
}

section('§2 processInstructionFile composes the guide and follows its @include')
for (const [encLabel, encode] of encodings) {
  const label = `${encLabel} CRLF${encLabel === 'UTF-8' ? ' (control)' : ''}`
  const { file } = guideFixture(`walk ${encLabel}`, encode(GUIDE.join('\r\n')))
  const entries = await discovery.processInstructionFile(
    { isExcluded: () => false } as never,
    file,
    'Project',
    new Set<string>(),
    false,
  )
  check(
    `${label}: the guide and its @include both compose`,
    entries.length === 2 && entries[0]?.content === BODY.join('\r\n') && entries[1]?.content === EXTRA,
    JSON.stringify(entries.map(e => e.content.slice(0, 32))),
  )
}

section('§3 seedFileKnowledgeFromInjectedInstructions compares the same decoded text')
{
  const PLAIN = '# Guide\n\nAlways run the linter before a commit.\n'
  for (const [encLabel, encode] of encodings) {
    const project = join(ROOT, slug(`seed ${encLabel}`))
    mkdirSync(project, { recursive: true })
    const guide = join(project, 'MERCURY.md')
    writeFileSync(guide, encode(PLAIN))
    setOriginalCwd(project)
    process.chdir(project)
    engine.clearInstructionFileCaches()
    const cache = createFileStateCacheWithSizeLimit(100)
    await engine.seedFileKnowledgeFromInjectedInstructions(cache)
    const seeded = cache.get(guide)
    if (encLabel === 'UTF-8') {
      check('UTF-8 (control): the injected guide is seeded with its exact disk text', seeded?.content === PLAIN, JSON.stringify(seeded?.content ?? 'not seeded'))
    } else {
      check(
        `${encLabel}: the injected guide is seeded with its decoded text`,
        seeded !== undefined && withoutBom(seeded.content) === PLAIN,
        JSON.stringify(seeded?.content?.slice(0, 32) ?? 'not seeded'),
      )
    }
  }
  process.chdir(launchDir)
  setOriginalCwd(launchDir)
  engine.clearInstructionFileCaches()
}

for (const dir of [ROOT, HOME]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}
console.log(failures === 0 ? `\nALL ${checks} INSTRUCTION DECODING CHECKS PASS` : `\n${failures} OF ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
