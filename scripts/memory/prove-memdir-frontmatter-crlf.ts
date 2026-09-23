#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildCardInput } from '../../src/memdir/experienceCards.ts'
import type { MnemeTopicDoc } from '../../src/memdir/mnemeTopicDocs.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'memdir-crlf-home-'))
const WORK = mkdtempSync(join(tmpdir(), 'memdir-crlf-work-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_MNEME

const { parseTopicDoc, serializeTopicDoc } = await import('../../src/memdir/mnemeTopicDocs.ts')
const { collectMemoryRefs } = await import('../../src/memdir/memoryRefs.ts')
const { buildExperienceCard, cardPromoteGate, normalizedLesson } = await import('../../src/memdir/experienceCards.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const crlf = (text: string): string => text.replaceAll('\n', '\r\n')
const copies: Array<[string, (text: string) => string]> = [
  ['CRLF', crlf],
  ['BOM+LF', text => `\uFEFF${text}`],
  ['BOM+CRLF', text => `\uFEFF${crlf(text)}`],
]
const every: Array<[string, (text: string) => string]> = [['LF', text => text], ...copies]

console.log('============================================================')
console.log(' memdir frontmatter readers — CRLF and BOM copies read like LF')
console.log('============================================================')

section('§1 parseTopicDoc reads a CRLF or BOM copy of the topic doc Mercury writes')
{
  const doc: MnemeTopicDoc = {
    id: 'topic-build',
    slug: 'build',
    summary: 'how the build runs',
    tokenCount: 0,
    created: '2000-01-01T00:00:00.000Z',
    updated: '2000-01-02T00:00:00.000Z',
    updateLog: ['2000-01-02T00:00:00.000Z consolidated 2 rows'],
    sections: [
      {
        heading: 'notes',
        entries: [
          { text: 'the build uses bun', seq: 2, time: '2000-01-02T00:00:00.000Z', source: 'operator' },
          { text: 'dist is one mjs file', seq: 3, time: '2000-01-02T00:00:00.000Z', source: 'build output', supersedes: '1' },
        ],
      },
    ],
    history: [{ text: 'the build used npm', seq: 1, time: '2000-01-01T00:00:00.000Z', source: 'operator', supersededBy: 3 }],
  }
  const lf = serializeTopicDoc(doc)
  const want = parseTopicDoc(lf)
  check(
    'LF (control): the doc parses back with its id, entries, history and update log',
    want !== null &&
      want.id === 'topic-build' &&
      want.sections[0]?.entries.length === 2 &&
      want.history[0]?.supersededBy === 3 &&
      want.updateLog.length === 1,
    JSON.stringify(want),
  )
  for (const [label, shape] of copies) {
    const got = parseTopicDoc(shape(lf))
    check(`${label}: parseTopicDoc returns the LF reading`, got !== null && JSON.stringify(got) === JSON.stringify(want), got === null ? 'null' : JSON.stringify(got).slice(0, 160))
  }
}

section('§2 readHead (through collectMemoryRefs) reads name, description, type and approved')
{
  const memDir = join(WORK, 'memory')
  mkdirSync(memDir, { recursive: true })
  const HEAD = '---\nname: blue-pipeline\ndescription: deploy through the zebrafrost pipeline\nmetadata:\n  type: experience-card\n  approved: false\n---\n\nbody\n'
  const fileOf = (label: string): string => `head-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`
  for (const [label, shape] of every) writeFileSync(join(memDir, fileOf(label)), shape(HEAD))
  const refs = collectMemoryRefs('zebrafrost rollout', {
    memoryDir: memDir,
    libraryDir: join(WORK, 'library'),
    projectRoot: null,
    maxRefs: 16,
  })
  for (const [label] of every) {
    const ref = refs.find(r => r.refId === `card:${fileOf(label)}`)
    check(
      `${label}${label === 'LF' ? ' (control)' : ''}: the header surfaces as a candidate experience card with its description`,
      ref !== undefined &&
        ref.kind === 'experience-card' &&
        ref.status === 'candidate' &&
        ref.summary === 'deploy through the zebrafrost pipeline',
      ref === undefined ? 'no ref' : JSON.stringify(ref),
    )
  }
}

section('§3 normalizedLesson (the experience-card reader) sees the same lesson in every copy')
{
  const LESSON = 'Rebuild the fixture index before rerunning the slow suite.'
  const base: BuildCardInput = {
    name: 'lesson-probe',
    title: 'Lesson probe',
    summary: 'a candidate lesson for the line-ending proof',
    problemClass: 'probe-class',
    lesson: LESSON,
    sourceRefs: ['commit:0000000'],
    createdAt: '2000-01-01T00:00:00.000Z',
    greenGate: true,
    approved: false,
    scope: 'general',
  }
  const card = (input: Partial<BuildCardInput>): string => {
    const built = buildExperienceCard({ ...base, ...input })
    if (!built.ok) throw new Error(`card build failed: ${JSON.stringify(built)}`)
    return built.markdown
  }
  const candidate = card({})
  const sibling = { problemClass: 'probe-class', markdown: card({ name: 'lesson-sibling', approved: true }) }
  const want = normalizedLesson(candidate)
  check('LF (control): normalizedLesson keeps the lesson line only', want === LESSON.toLowerCase(), want)
  for (const [label, shape] of copies) {
    const got = normalizedLesson(shape(candidate))
    check(`${label}: normalizedLesson returns the LF reading`, got === want, got.slice(0, 120))
  }
  for (const [label, shape] of every) {
    const verdict = cardPromoteGate(shape(candidate), [sibling])
    check(
      `${label}${label === 'LF' ? ' (control)' : ''}: the promote gate finds the approved sibling with the same lesson`,
      verdict.ok === false && /already covered/.test(verdict.reason),
      JSON.stringify(verdict),
    )
  }
}

for (const dir of [WORK, HOME]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}
console.log(failures === 0 ? `\nALL ${checks} MEMDIR LINE-ENDING CHECKS PASS` : `\n${failures} OF ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
