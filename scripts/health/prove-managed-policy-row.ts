#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'managed-policy-row-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const fsOps = await import('../../src/utils/fsOperations.js')
const { getManagedFilePath } = await import('../../src/utils/settings/managedPath.js')
const report = await import('../../src/utils/healthReport.js')

const policyPath = join(getManagedFilePath(), 'managed-settings.json')
const real = fsOps.getFsImplementation()
type Planted = { text?: string; error?: NodeJS.ErrnoException }
const plant = (planted: Planted | null): void => {
  fsOps.setFsImplementation({
    ...real,
    existsSync: ((path: string) => (path === policyPath ? planted !== null : real.existsSync(path))) as never,
    readFileSync: ((path: string, options?: unknown) => {
      if (path !== policyPath) return (real.readFileSync as (p: string, o?: unknown) => unknown)(path, options)
      if (planted === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (planted.error) throw planted.error
      return planted.text
    }) as never,
  } as never)
}
const row = async (): Promise<{ status: string; evidence: string; fix: string } | null> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const r = cert.sections.flatMap(s => s.checks).find(c => c.id === 'managed-policy')
  return r ? { status: String(r.status), evidence: String(r.evidence), fix: String((r as { fix?: string }).fix ?? '') } : null
}

try {
  console.log('§1 no managed policy: the row exists and reads info, naming the path')
  {
    plant(null)
    const r = await row()
    check('RED ON THE BASE: /health carries a managed-policy row', r !== null)
    check('absent reads info and names the path it looked at', r?.status === 'info' && r.evidence.includes(policyPath), `${r?.status}: ${r?.evidence}`)
  }

  console.log('\n§2 an invalid lock value warns with the issue and the reader\'s consequence')
  {
    plant({ text: JSON.stringify({ extensions: { exclusive: 42 } }) })
    const r = await row()
    check('warn, naming extensions.exclusive', r?.status === 'warn' && r.evidence.includes('extensions.exclusive has an invalid value'), `${r?.status}: ${r?.evidence}`)
    check('the fix says the value reads as a full lock and teaches the accepted forms', r?.fix.includes('reads as a full lock') === true && r.fix.includes('Acceptable forms: true, or an array of surface names'), r?.fix ?? '')
  }

  console.log('\n§3 an unrecognised surface name warns and the fix says ignored')
  {
    plant({ text: JSON.stringify({ extensions: { exclusive: ['skills', 'frobnicate'] } }) })
    const r = await row()
    check('warn, naming the unrecognised surface', r?.status === 'warn' && r.evidence.includes('unrecognised surface name') && r.evidence.includes('frobnicate'), `${r?.status}: ${r?.evidence}`)
    check('the fix says the name is ignored', r?.fix.includes('ignored') === true, r?.fix ?? '')
  }

  console.log('\n§4 a policy that exists but cannot be read warns naming the error')
  {
    plant({ error: Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
    const r = await row()
    check('warn, naming EACCES', r?.status === 'warn' && r.evidence.includes('could not be read (EACCES)'), `${r?.status}: ${r?.evidence}`)
    check('the fix says none of its settings apply', r?.fix.includes('none of its settings apply') === true, r?.fix ?? '')
  }

  console.log('\n§5 a clean policy reads ok')
  {
    plant({ text: JSON.stringify({ extensions: { exclusive: ['skills'] } }) })
    const r = await row()
    check('ok, naming the policy path', r?.status === 'ok' && r.evidence.includes('read clean') && r.evidence.includes(policyPath), `${r?.status}: ${r?.evidence}`)
  }
} finally {
  fsOps.setFsImplementation(real)
}

console.log(`\n${failures === 0 ? '✅ prove-managed-policy-row: /health reads the managed policy' : `❌ prove-managed-policy-row: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
