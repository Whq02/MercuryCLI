import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'backup-finder-ladder-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const config = await import(join(SRC, 'utils/config/globalConfig.ts'))
const find = config.findMostRecentBackup as (f: string) => string | null
const backupHome = config.getConfigBackupDir() as string
const beside = join(HOME, 'beside')
mkdirSync(beside, { recursive: true })
const file = join(beside, '.mercury.json')
writeFileSync(file, '{}\n')

try {
  check('nothing anywhere answers null', find(file) === null, String(find(file)))

  writeFileSync(`${file}.backup`, '{"bare":true}\n')
  check('the bare .backup sibling is the last resort', find(file) === `${file}.backup`, String(find(file)))

  writeFileSync(join(beside, '.mercury.json.backup.1700000000000'), '{}\n')
  writeFileSync(join(beside, '.mercury.json.backup.1700000000999'), '{}\n')
  writeFileSync(join(beside, '.mercury.json.backup.1600000000000'), '{}\n')
  writeFileSync(join(beside, 'other.json.backup.1900000000000'), '{}\n')
  check('a timestamped sibling beats the bare one and the greatest stamp wins, only for this file name', find(file) === join(beside, '.mercury.json.backup.1700000000999'), String(find(file)))

  mkdirSync(backupHome, { recursive: true })
  writeFileSync(join(backupHome, '.mercury.json.backup.1000'), '{}\n')
  check('any copy in the backup home beats every sibling, whatever its stamp', find(file) === join(backupHome, '.mercury.json.backup.1000'), String(find(file)))
  writeFileSync(join(backupHome, '.mercury.json.backup.3000'), '{}\n')
  writeFileSync(join(backupHome, '.mercury.json.backup.2000'), '{}\n')
  writeFileSync(join(backupHome, 'settings.json.backup.9000'), '{}\n')
  check('in the backup home the greatest stamp for this file name wins', find(file) === join(backupHome, '.mercury.json.backup.3000'), String(find(file)))

  rmSync(backupHome, { recursive: true, force: true })
  const sealed = join(HOME, 'sealed')
  mkdirSync(sealed)
  const sealedFile = join(sealed, '.mercury.json')
  writeFileSync(`${sealedFile}.backup`, '{}\n')
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(sealed, 0o311)
    check('a folder that cannot be listed counts as holding no backup', find(sealedFile) === null, String(find(sealedFile)))
    chmodSync(sealed, 0o755)
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
}
console.log(failures ? `FAIL backup finder ladder: ${failures} failures` : 'PASS backup finder ladder')
process.exit(failures ? 1 : 0)
