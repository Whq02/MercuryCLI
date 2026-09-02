#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-mdm-tier-at-boot.ts — the registry/plist policy
//  tier is loaded into its caches at the boot barrier, not thirty minutes
//  later (release-hardening audit rank 22).
//
//  The class: main.tsx's preAction awaited getMdmRawReadPromise() and
//  DISCARDED the result. ensureMdmSettingsLoaded — the function that parses
//  the raw read into the mdm/hkcu caches — had no caller anywhere; the only
//  cache writer was the change detector's 30-minute poll. So a policy
//  delivered through the Windows registry or the macOS managed-preferences
//  plists (permission deny/ask rules, disableBypassPermissionsMode,
//  allowManagedHooksOnly, allowManagedMcpServersOnly, ...) was simply
//  absent from the merged settings for the first thirty minutes: sessions
//  shorter than that never saw it, longer ones saw a tool permitted a
//  minute earlier start being denied mid-session with no explanation, and
//  getPolicySettingsOrigin() named the wrong origin. Bare and remote modes
//  never run the poll, so they never saw it at all.
//
//   L1  the mechanism: with a scripted startup raw read carrying a policy,
//       the pre-fix barrier (await the raw read, read settings) leaves the
//       tier EMPTY and the merged settings without the policy
//   L2  the fix's barrier (ensureMdmSettingsLoaded, then a settings-cache
//       reset) puts the policy into the tier, the merged settings and the
//       origin — from the same in-flight startup read (no second read)
//   L3  the wiring: main.tsx's preAction rides ensureMdmSettingsLoaded with
//       a never-fail-the-boot guard, resets the settings cache after it,
//       and no longer awaits the raw read bare
//   L4  a failed raw read at boot degrades to no policy tier without
//       throwing out of the barrier
//
//  Each behavioural scenario runs in its own fresh bun subprocess (the
//  tier caches memoize per process); the raw read is stood in through the
//  proof seam (_setMdmRawReadForProofs). PROVE_SRC names another checkout's
//  src (the A/B control: against the pre-fix tree L3 reads red and the
//  seam-dependent legs are skipped, L1's mechanism holding on both trees).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const SEAM_PRESENT = existsSync(join(SRC, 'utils/settings/mdm/rawRead.ts')) && readFileSync(join(SRC, 'utils/settings/mdm/rawRead.ts'), 'utf8').includes('_setMdmRawReadForProofs')

const POLICY = { permissions: { deny: ['Bash(rm:*)'] }, disableBypassPermissionsMode: 'disable' }

function runIn(body: string): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'mdm-boot-'))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const raw = await import(${JSON.stringify(join(SRC, 'utils/settings/mdm/rawRead.ts'))})
    const mdm = await import(${JSON.stringify(join(SRC, 'utils/settings/mdm/settings.ts'))})
    const s = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    const cache = await import(${JSON.stringify(join(SRC, 'utils/settings/settingsCache.ts'))})
    const policy = ${JSON.stringify(POLICY)}
    const tier = () => ({ keys: Object.keys(mdm.getMdmSettings().settings), origin: s.getPolicySettingsOrigin() })
    const merged = () => { const r = s.getSettingsWithErrors(); return { deny: r.settings?.permissions?.deny ?? null, bypass: r.settings?.disableBypassPermissionsMode ?? null } }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

// ── L1: the mechanism ──────────────────────────────────────────────────────
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
  const merged = r.merged as { deny: string[] | null; bypass: string | null }
  check('the bare await leaves the mdm tier empty (the defect mechanism)', tier.keys.length === 0 && tier.origin === null, JSON.stringify(tier))
  check('...and the merged settings carry no policy', merged.deny === null && merged.bypass === null, JSON.stringify(merged))
}

// ── L2: the fix's barrier ──────────────────────────────────────────────────
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
  const merged = r.merged as { deny: string[] | null; bypass: string | null }
  check('the mdm tier carries the policy keys', tier.keys.includes('permissions') && tier.keys.includes('disableBypassPermissionsMode'), JSON.stringify(tier))
  check('the policy origin is the plist tier', tier.origin === 'plist', `origin=${tier.origin}`)
  check('the merged settings carry the deny rule and the bypass lock', merged.deny?.[0] === 'Bash(rm:*)' && merged.bypass === 'disable', JSON.stringify(merged))
  check('the load reused the one in-flight startup read', r.reads === 1, `reads=${r.reads}`)
}

// ── L3: the wiring ─────────────────────────────────────────────────────────
console.log('L3 wiring — main.tsx drives the tier load at the boot barrier')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  // Anchored on the tier import itself: main.tsx registers TWO preAction
  // hooks and the MDM barrier lives under the second, ~14 KB past a slice
  // taken from the first — these needles read -1 from the day the hooks
  // split, whatever the barrier's spelling.
  const at = main.indexOf('const { ensureMdmSettingsLoaded')
  const hook = at >= 0 ? main.slice(Math.max(0, at - 400), at + 3000) : ''
  check('the barrier sits inside a preAction hook', at >= 0 && main.lastIndexOf("program.hook('preAction'", at) >= 0)
  const loadAt = hook.indexOf('await ensureMdmSettingsLoaded()')
  const resetAt = hook.indexOf('resetSettingsCache()', loadAt)
  const initAt = hook.indexOf('await init()')
  check('the tier import exists in main.tsx', at >= 0)
  check('the barrier awaits ensureMdmSettingsLoaded (the tier parse), not the bare raw read', loadAt >= 0 && !hook.includes('await getMdmRawReadPromise()'))
  check('a failed load never stops the boot (guarded)', loadAt >= 0 && hook.slice(loadAt, loadAt + 200).includes('.catch('))
  check('the settings cache is reset after the load and before init()', loadAt >= 0 && resetAt > loadAt && initAt > resetAt, `load=${loadAt} reset=${resetAt} init=${initAt}`)
}

// ── L4: a failed read degrades, never throws ───────────────────────────────
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
  check('the guarded barrier absorbs the failure', typeof r.threw === 'string' && !(r.threw as string).startsWith('escaped'), String(r.threw))
  check('the tier reads empty (no policy) rather than poisoned', tier.keys.length === 0 && tier.origin === null, JSON.stringify(tier))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
