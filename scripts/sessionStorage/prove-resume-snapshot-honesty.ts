#!/usr/bin/env bun
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const SCRATCH = mkdtempSync(join(tmpdir(), 'resume-snapshot-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const loading = await import(join(SRC, 'utils/sessionStorage/loading.ts'))
const snapshot = await import(join(SRC, 'utils/sessionStorage/resumeSnapshot.ts'))
const vnext = await import(join(SRC, 'utils/sessionStorage/vnext.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const record = (filePath: string, words: string): string =>
  (vnext.encodeTranscriptLine(filePath, {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: words },
  }) as { line: string }).line

async function messagesIn(filePath: string): Promise<number> {
  const result = (await loading.loadTranscriptFile(filePath)) as { messages: Map<string, unknown> }
  return result.messages.size
}
function snapshotCursor(filePath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(`${filePath}.resume-snapshot.json`, 'utf8')) as { byteCursor?: number }
    return raw.byteCursor ?? null
  } catch {
    return null
  }
}

async function seed(name: string, n: number): Promise<{ file: string; cursor: number }> {
  const file = join(SCRATCH, `${name}.jsonl`)
  writeFileSync(file, '')
  for (let i = 0; i < n; i++) appendFileSync(file, record(file, `prefix words ${i} ${'x'.repeat(200)}`))
  const cursor = statSync(file).size
  const fold = await loading.loadTranscriptFile(file)
  snapshot.writeResumeSnapshot(file, fold as never, cursor)
  return { file, cursor }
}
const snapshotPathOf = (file: string): string => (snapshot.snapshotPathFor as ((p: string) => string) | undefined)?.(file) ?? `${file}.resume-snapshot.json`
const cursorOf = (file: string): number | null => {
  try {
    return (JSON.parse(readFileSync(snapshotPathOf(file), 'utf8')) as { byteCursor?: number }).byteCursor ?? null
  } catch {
    return snapshotCursor(file)
  }
}

console.log('L1 a refused >1 MB tail: no cursor advance, the history past the foreign line still resumes')
{
  const { file, cursor } = await seed('refused', 5)
  const before = cursorOf(file)
  t('premise: the seeded snapshot covers the prefix', before === cursor, `cursor=${before} expected=${cursor}`)
  appendFileSync(file, '{"foreign":"not a record line"}\n')
  let added = 0
  while (statSync(file).size - cursor < 1.2 * 1024 * 1024) {
    appendFileSync(file, record(file, `tail words ${added} ${'y'.repeat(400)}`))
    added++
  }
  const messages = await messagesIn(file)
  t('the records past the foreign line resume (the load fell through to the plain road)', messages === 5 + added, `messages=${messages} expected=${5 + added}`)
  const again = await messagesIn(file)
  const after = cursorOf(file)
  t('the snapshot standing after the load covers what it claims (a second resume sees every record)', again === 5 + added, `second resume messages=${again} expected=${5 + added} cursor=${after}`)
}

console.log('L2 control — a clean >1 MB tail folds from the snapshot and earns the refresh')
{
  const { file, cursor } = await seed('clean', 5)
  let added = 0
  while (statSync(file).size - cursor < 1.2 * 1024 * 1024) {
    appendFileSync(file, record(file, `tail words ${added} ${'z'.repeat(400)}`))
    added++
  }
  const messages = await messagesIn(file)
  const after = cursorOf(file)
  t('the clean tail folds', messages === 5 + added, `messages=${messages} expected=${5 + added}`)
  t('the refresh advances the cursor to the folded extent', after === statSync(file).size, `cursor=${after} size=${statSync(file).size}`)
}

console.log('L3 a short read invalidates the hit')
{
  const src = readFileSync(join(SRC, 'utils/sessionStorage/resumeSnapshot.ts'), 'utf8')
  const loopAt = src.indexOf('readSync(fd, tail, read, tailLen - read, cursor + read)')
  const guardAt = src.indexOf('if (read < tailLen) return null')
  t('the read loop exists', loopAt >= 0)
  t('a short read returns null instead of the padded buffer', guardAt > loopAt && loopAt >= 0, `loop=${loopAt} guard=${guardAt}`)
}

console.log(failures === 0 ? 'RESUME SNAPSHOT HONESTY: ALL PASS' : 'RESUME SNAPSHOT HONESTY: RED')
process.exit(failures)
