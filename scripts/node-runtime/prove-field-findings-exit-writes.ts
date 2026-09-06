#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const hasAdjacentStreamWriteExit = (src: string): boolean => {
  const lines = src.split('\n')
  return lines.some((l, i) => {
    if (!/process\.std(err|out)\.write\(/.test(l)) return false
    return lines.slice(i + 1, i + 4).some(n => /process\.exit\(/.test(n))
  })
}

console.log('§1 the discardable write-then-exit shape is out of the fixed owners')
for (const rel of [
  'src/utils/windowsPaths.ts',
  'src/cli/structuredIO.ts',
  'src/services/tcpBridge/entry.ts',
  'src/cli/handlers/auth.ts',
  'src/main.tsx',
]) {
  check(`${rel} carries no stream-write-then-exit pair`, !hasAdjacentStreamWriteExit(read(rel)))
}
{
  const cli = read('src/entrypoints/cli.tsx')
  check(
    'cli.tsx: the acp usage exit is a lazy writeSync, not the stream',
    cli.includes("const { writeSync } = await import('node:fs')") && !cli.includes("process.stderr.write('Usage: mercury acp --stdio"),
  )
}

console.log('§2 the discipline is in: writeSync beside the exits the audit fixed')
{
  const wp = read('src/utils/windowsPaths.ts')
  check(
    'the git-bash refusal writes sync (the pin arm) and the remedy words stand',
    (wp.match(/writeSync\(\s*2,/g) ?? []).length >= 1 && wp.includes('requires git-bash'),
  )
  const main = read('src/main.tsx')
  check('the --version line writes sync', main.includes('writeSync(1, `Mercury ${MERCURY_VERSION}\\n`)'))
  check('the rollback refusal writes sync', main.includes("writeSync(2, 'Rollback is an update operation"))
  const auth = read('src/cli/handlers/auth.ts')
  check("both sign-in results write sync", (auth.match(/writeSync\(1, /g) ?? []).length >= 4)
  const sio = read('src/cli/structuredIO.ts')
  check('fatalProtocolError writes sync', sio.includes('writeSync(2, `${reason}\\n`)'))
}

process.exit(failures === 0 ? 0 : 1)
