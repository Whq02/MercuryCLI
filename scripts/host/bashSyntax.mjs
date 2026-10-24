import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function bashSyntax(script) {
  const dir = mkdtempSync(join(tmpdir(), 'bash-syntax-'))
  const file = join(dir, 'script.sh')
  writeFileSync(file, script)
  try {
    return spawnSync('bash', ['-n', file.replaceAll('\\', '/')], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
