#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn13-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

try {
  const { vendorClient } = await import('../../src/services/host/vendors/client.ts')

  {
    const credDir = join(home, '.host-credentials')
    mkdirSync(credDir, { recursive: true, mode: 0o700 })
    const credId = randomUUID()
    const credFile = join(credDir, credId + '.json')
    writeFileSync(credFile, '{not valid json', { mode: 0o600 })
    const record = {
      id: 'hf-job-1',
      vendor: 'huggingface' as const,
      huggingfaceCredential: { home, source: 'captured' as const, id: credId, job: 'hf-job-1' },
    }
    let corruptMsg = ''
    try {
      vendorClient(record)
    } catch (error) {
      corruptMsg = error instanceof Error ? error.message : String(error)
    }
    check(
      'vendorClient surfaces corrupt captured Hugging Face credential read error instead of generic key-unavailable',
      corruptMsg.includes('The saved host credential could not be read.'),
      `got: ${corruptMsg}`,
    )

    if (POSIX_MODES) {
      const unreadableId = randomUUID()
      const unreadableFile = join(credDir, unreadableId + '.json')
      writeFileSync(unreadableFile, JSON.stringify({ key: 'hf_secret' }) + '\n', { mode: 0o600 })
      chmodSync(unreadableFile, 0o200)
      let eaccesMsg = ''
      try {
        vendorClient({
          id: 'hf-job-2',
          vendor: 'huggingface',
          huggingfaceCredential: { home, source: 'captured', id: unreadableId, job: 'hf-job-2' },
        })
      } catch (error) {
        eaccesMsg = error instanceof Error ? error.message : String(error)
      } finally {
        chmodSync(unreadableFile, 0o600)
      }
      check(
        'vendorClient surfaces EACCES on captured Hugging Face credential instead of generic key-unavailable',
        eaccesMsg.includes('The saved host credential could not be read.'),
        `got: ${eaccesMsg}`,
      )
    }

    let missingMsg = ''
    try {
      vendorClient({
        id: 'hf-job-3',
        vendor: 'huggingface',
        huggingfaceCredential: { home, source: 'captured', id: randomUUID(), job: 'hf-job-3' },
      })
    } catch (error) {
      missingMsg = error instanceof Error ? error.message : String(error)
    }
    check(
      'vendorClient preserves job-specific missing Hugging Face credential message',
      missingMsg.includes('The saved Hugging Face credential for this job is unavailable.'),
      `got: ${missingMsg}`,
    )

    let explicitOk = false
    try {
      const client = vendorClient(record, { key: 'hf_explicit_override' })
      explicitOk = client.vendor === 'huggingface'
    } catch {
      explicitOk = false
    }
    check(
      'vendorClient with explicit options.key still succeeds when record credential cannot be read',
      explicitOk,
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
