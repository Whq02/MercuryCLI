// ============================================================================
//  scripts/tool-economy/hermeticHome.ts — the live drills' credentialed
//  scratch home.
//
//  A live drill needs the operator's REAL credentials (a live route bills the
//  operator's own account) but must never WRITE the operator's home — the
//  live-E2E hermeticity law (scripts/substrate/prove-live-e2e-hermetic.ts):
//  sessions, history, the deferral probe's verdict store, every write lands in
//  a scratch config home seeded with the credential and secret stores alone.
//  The seed is a byte copy; the real stores are never opened for writing.
// ============================================================================
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** The stores a live route resolves credentials through (auth.ts, router/providerSecrets.ts). */
const CREDENTIAL_STORES = ['.credentials.json', '.provider-secrets.json'] as const

/** The operator's config home as the product resolves it before any pin:
 *  MERCURY_CONFIG_DIR when set, else the default home under the user's home. */
function realConfigHome(): string {
  return process.env.MERCURY_CONFIG_DIR ?? join(homedir(), '.mercury')
}

/**
 * Create a private scratch config home, seed it with the credential stores
 * found in the real home, and pin MERCURY_CONFIG_DIR to it. Returns the
 * scratch home. Call BEFORE any product import — the config home is read at
 * module load.
 */
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
