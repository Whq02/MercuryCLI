#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
let SEAM_PRESENT = false
try {
  const rawMod = await import(join(SRC, 'platform/settings/mdm/rawRead.ts'))
  SEAM_PRESENT = typeof rawMod._setMdmRawReadForProofs === 'function'
} catch {
  SEAM_PRESENT = false
}

const POLICY = { guardrails: { deny: ['Bash(rm *)'], disableSovereignMode: true }, events: { managedOnly: true } }

function runIn(body: string): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'mdm-boot-'))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const raw = await import(${JSON.stringify(join(SRC, 'platform/settings/mdm/rawRead.ts'))})
    const mdm = await import(${JSON.stringify(join(SRC, 'platform/settings/mdm/settings.ts'))})
    const s = await import(${JSON.stringify(join(SRC, 'platform/settings/settings.ts'))})
    const cache = await import(${JSON.stringify(join(SRC, 'platform/settings/settingsCache.ts'))})
    const policy = ${JSON.stringify(POLICY)}
    const tier = () => ({ keys: Object.keys(mdm.getMdmSettings().settings), origin: s.getPolicySettingsOrigin() })
    const merged = () => { const r = s.getSettingsWithErrors(); return { deny: r.settings?.guardrails?.deny ?? null, sovereignLock: r.settings?.guardrails?.disableSovereignMode ?? null, hooksLock: r.settings?.events?.managedOnly ?? null } }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

console.log('L1 mechanism — awaiting the raw read bare leaves the tier empty')
if (!SEAM_PRESENT) skip('L1', 'the proof seam is absent in this src (pre-fix tree)')
else {
  const r = runIn(`
    raw._setMdmRawReadForProofs({ plistStdouts: [{ stdout: JSON.stringify(policy), label: 'proof plist' }], hklmStdout: null, hkcuStdout: null })
    await raw.getMdmRawReadPromise()   // the pre-fix barrier: await, discard
    out.tier = tier()
    out.merged = merged()
  `)
  const tier = r.tier as { keys: string[]; origin: string | null }
  const merged = r.merged as { deny: string[] | null; sovereignLock: boolean | null; hooksLock: boolean | null }
  check('the bare await leaves the mdm tier empty (the defect mechanism)', tier.keys.length === 0 && tier.origin === null, JSON.stringify(tier), 'awaiting getMdmRawReadPromise in src/platform/settings/mdm/rawRead.ts alone must not fill the tier that getMdmSettings in src/platform/settings/mdm/settings.ts returns: only ensureMdmSettingsLoaded loads it')
  check('...and the merged settings carry no policy', merged.deny === null && merged.sovereignLock === null && merged.hooksLock === null, JSON.stringify(merged), 'the merged settings read by getSettingsWithErrors in src/platform/settings/settings.ts must not include policy before ensureMdmSettingsLoaded has run')
}

console.log('L2 the barrier — ensureMdmSettingsLoaded plus a cache reset puts the policy in force')
if (!SEAM_PRESENT) skip('L2', 'the proof seam is absent in this src (pre-fix tree)')
else {
  const r = runIn(`
    let reads = 0
    raw._setMdmRawReadForProofs((async () => { reads++; return { plistStdouts: [{ stdout: JSON.stringify(policy), label: 'proof plist' }], hklmStdout: null, hkcuStdout: null } })())
    // A merged read BEFORE the barrier memoizes an empty policy view — the
    // cache reset after the barrier is what lets the first real read see it.
    out.before = merged()
    await mdm.ensureMdmSettingsLoaded()
    cache.resetSettingsCache()
    out.tier = tier()
    out.merged = merged()
    out.reads = reads
  `)
  const tier = r.tier as { keys: string[]; origin: string | null }
  const merged = r.merged as { deny: string[] | null; sovereignLock: boolean | null; hooksLock: boolean | null }
  check('the mdm tier carries the policy keys', tier.keys.includes('guardrails') && tier.keys.includes('events'), JSON.stringify(tier), 'ensureMdmSettingsLoaded in src/platform/settings/mdm/settings.ts must fill the tier from the raw read so getMdmSettings returns the policy keys')
  check('the policy origin is the plist tier', tier.origin === 'plist', `origin=${tier.origin}`, 'getPolicySettingsOrigin in src/platform/settings/settings.ts must report plist when the policy came from the plist read')
  check('the merged settings carry the deny rule, the sovereign lock and the hooks lock', merged.deny?.[0] === 'Bash(rm *)' && merged.sovereignLock === true && merged.hooksLock === true, JSON.stringify(merged), 'after ensureMdmSettingsLoaded and resetSettingsCache the merge in getSettingsWithErrors in src/platform/settings/settings.ts must include the mdm tier')
  check('the load reused the one in-flight startup read', r.reads === 1, `reads=${r.reads}`, 'ensureMdmSettingsLoaded in src/platform/settings/mdm/settings.ts must reuse the in-flight read from getMdmRawReadPromise, not start a second one')
}


console.log('L4 a failed raw read at boot degrades to no policy tier')
if (!SEAM_PRESENT) skip('L4', 'the proof seam is absent in this src (pre-fix tree)')
else {
  const r = runIn(`
    raw._setMdmRawReadForProofs(Promise.reject(new Error('plutil exploded')))
    let threw = null
    try { await mdm.ensureMdmSettingsLoaded().catch(e => { threw = String(e) }) } catch (e) { threw = 'escaped: ' + String(e) }
    cache.resetSettingsCache()
    out.threw = threw
    out.tier = tier()
  `)
  const tier = r.tier as { keys: string[]; origin: string | null }
  check('the guarded barrier absorbs the failure', typeof r.threw === 'string' && !(r.threw as string).startsWith('escaped'), String(r.threw), 'ensureMdmSettingsLoaded in src/platform/settings/mdm/settings.ts must catch a rejected raw read instead of letting it escape')
  check('the tier reads empty (no policy) rather than poisoned', tier.keys.length === 0 && tier.origin === null, JSON.stringify(tier), 'a failed raw read must leave the tier empty: check how src/platform/settings/mdm/settings.ts stores the result when the read rejects')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
