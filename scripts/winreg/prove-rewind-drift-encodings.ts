#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const launchDir = process.cwd()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'rewind-drift-home-')))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'rewind-drift-work-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
process.chdir(work)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(true)
bootstrap.setOriginalCwd(work)
const fileHistory = await import('../../src/utils/fileHistory.ts')
const fileRead = await import('../../src/utils/fileRead.ts')
const { readFileInRange } = await import('../../src/utils/readFileInRange.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ageBy = (path: string, seconds: number): void => {
  const t = (Date.now() - seconds * 1000) / 1000
  utimesSync(path, t, t)
}
const bom8 = (t: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')])
const utf16 = (t: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')])
const encodings: Array<[string, (t: string) => Buffer, string]> = [
  ['UTF-8 LF', t => Buffer.from(t, 'utf8'), '\n'],
  ['UTF-8 CRLF', t => Buffer.from(t, 'utf8'), '\r\n'],
  ['UTF-8 BOM LF', bom8, '\n'],
  ['UTF-8 BOM CRLF', bom8, '\r\n'],
  ['UTF-16LE LF', utf16, '\n'],
]

async function restoreAfter(label: string, encode: (t: string) => Buffer, eol: string, toucher: 'edit' | 'read', outsideChange: boolean) {
  let state: unknown = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  const update = (fn: (previous: unknown) => unknown): void => {
    state = fn(state)
  }
  const file = join(work, `${label.replace(/[^a-z0-9]/gi, '')}-${toucher}-${outsideChange ? 'changed' : 'touched'}.txt`)
  writeFileSync(file, encode(`a${eol}b${eol}`))
  ageBy(file, 30)
  const first = randomUUID()
  await fileHistory.fileHistoryMakeSnapshot(update as never, first)
  await fileHistory.fileHistoryTrackEdit(update as never, file, first)
  writeFileSync(file, encode(`c${eol}d${eol}`))
  ageBy(file, 20)
  await fileHistory.fileHistoryMakeSnapshot(update as never, randomUUID())
  const content = toucher === 'edit' ? fileRead.readFileSyncWithMetadata(file).content : (await readFileInRange(file, 0)).content
  const cache = new Map([[file, { content, timestamp: Math.floor(statSync(file).mtimeMs), offset: toucher === 'read' ? 0 : undefined, limit: undefined }]])
  if (outsideChange) writeFileSync(file, encode(`e${eol}f${eol}`))
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  return fileHistory.fileHistoryRestore(state as never, first, { dryRun: true, ownerKey: `drift-${label}-${toucher}-${outsideChange}`, drift: cache as never })
}

console.log('============================================================')
console.log(' rewind drift check across file encodings')
console.log('============================================================')

for (const [label, encode, eol] of encodings) {
  for (const toucher of ['edit', 'read'] as const) {
    const out = (await restoreAfter(label, encode, eol, toucher, false)) as { ok: boolean; kind?: string }
    check(`${label}, last touched by ${toucher}: a timestamp-only touch leaves it restorable`, out.ok === true, out.ok ? '' : `refused ${out.kind}`)
  }
}
for (const [label, encode, eol] of [encodings[0]!, encodings[1]!, encodings[4]!]) {
  const out = (await restoreAfter(label, encode, eol, 'edit', true)) as { ok: boolean; kind?: string }
  check(`${label}: a real change made outside the session still refuses as drift`, out.ok === false && out.kind === 'drift', JSON.stringify(out).slice(0, 120))
}

process.chdir(launchDir)
for (const dir of [work, home]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}
console.log(failures === 0 ? '\nALL REWIND DRIFT ENCODING CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
