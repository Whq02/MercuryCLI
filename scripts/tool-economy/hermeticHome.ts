import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const CREDENTIAL_STORES = ['.credentials.json', '.provider-secrets.json'] as const

function realConfigHome(): string {
  return process.env.MERCURY_CONFIG_DIR ?? join(homedir(), '.mercury')
}

export function pinHermeticCredentialedHome(prefix: string): string {
  const real = realConfigHome()
  const home = mkdtempSync(join(tmpdir(), prefix))
  for (const name of CREDENTIAL_STORES) {
    const source = join(real, name)
    if (existsSync(source)) copyFileSync(source, join(home, name))
  }
  process.env.MERCURY_CONFIG_DIR = home
  return home
}
