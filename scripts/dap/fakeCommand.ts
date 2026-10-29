import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PRINTER = [
  "import { readFileSync } from 'node:fs'",
  "import { basename, dirname, join } from 'node:path'",
  'const exe = process.execPath',
  "process.stdout.write(readFileSync(join(dirname(exe), basename(exe).replace(/\\.exe$/i, '') + '.out'), 'utf8'))",
  '',
].join('\n')

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
const printers = new Map<string, string>()

function printerFor(scratch: string): string {
  const known = printers.get(scratch)
  if (known !== undefined) return known
  const dir = join(scratch, 'fake-printer')
  mkdirSync(dir, { recursive: true })
  const source = join(dir, 'printer.ts')
  writeFileSync(source, PRINTER)
  const exe = join(dir, 'printer.exe')
  const built = spawnSync(process.execPath, ['build', '--compile', source, '--outfile', exe], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  if (built.status !== 0 || !existsSync(exe)) throw new Error(`the fake printer did not compile (${process.execPath} build --compile): ${built.stderr}`)
  printers.set(scratch, exe)
  return exe
}

export function fakeCommand(dir: string, name: string, output: string, scratch: string, platform: string = process.platform): string {
  mkdirSync(dir, { recursive: true })
  if (platform !== 'win32') {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\nprintf '%s' ${quoted(output)}\n`)
    chmodSync(file, 0o755)
    return file
  }
  const exe = join(dir, `${name}.exe`)
  const printer = printerFor(scratch)
  try {
    linkSync(printer, exe)
  } catch {
    copyFileSync(printer, exe)
  }
  writeFileSync(join(dir, `${name}.out`), output)
  return exe
}
