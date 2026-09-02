
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  delete process.env[name]
}

export const proofHome: string = mkdtempSync(join(tmpdir(), 'proof-home-'))
process.env.MERCURY_CONFIG_DIR = proofHome
