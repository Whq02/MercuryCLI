#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-config-unreadable-honesty.ts — a global config
//  file that EXISTS but cannot be read is a refusal, never a first run
//  (release-hardening audit rank 14).
//
//  The class: getConfig's catch handled ENOENT (absent → defaults) and
//  ConfigParseError (corrupt → quarantine + defaults) and let every other
//  errno — EACCES/EPERM on the file or an ancestor, EBUSY from a Windows
//  sharing violation while a scanner holds the file, EIO, EISDIR — fall
//  through to the same defaults view with no line and no throw. The boot
//  then ran as a first run (onboarding again, the trust dialog again, the
//  account signed out), and because getGlobalConfig seeded its cache from
//  that view the auth-wipe guard compared a defaults re-read against
//  defaults and let the first save publish them over the operator's real
//  account, per-project records and trust grants.
//
//   L1  boot gate: enableConfigs() on a present-but-unreadable file throws
//       a typed ConfigReadError naming the path and the errno — not a
//       quiet return
//   L2  the cache: getGlobalConfig() never seeds itself from a failed read
//       (it throws the same class; hasCompletedOnboarding is not quietly
//       false)
//   L3  the save (the destructive half): with the file unreadable after
//       boot, saveGlobalConfig refuses without throwing at its caller — the
//       bytes on disk are identical afterwards (before the fix: defaults
//       plus the update replaced the real state)
//   L4  the sibling writer: saveCurrentProjectConfig refuses the same way
//   L5  controls: an ABSENT file still yields defaults quietly (no throw),
//       and a CORRUPT file under throwOnInvalid still throws
//       ConfigParseError — the two existing arms are untouched
//   L6  the boot boundary: init.ts turns ConfigReadError into a named
//       stderr refusal and a non-zero exit — never the reset-to-defaults
//       dialog, whose reset would be the very overwrite this class refuses
//
//  Each scenario runs in its own fresh bun subprocess with its own scratch
//  MERCURY_CONFIG_DIR — the global config memoizes per process. The
//  unreadable file is modelled through the product's own fs seam
//  (setFsImplementation: readFileSync of the config path throws EBUSY), the
//  Windows sharing-violation shape, platform-neutral. PROVE_SRC names
//  another checkout's src (the A/B control: against the pre-fix tree L1–L4
//  and L6 read red while L5 stays green).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

/** The operator's real state: signed in, onboarded, one trusted project. */
const REAL_STATE = {
  hasCompletedOnboarding: true,
  oauthAccount: { accountUuid: 'acct-1', emailAddress: 'op@example.test', organizationUuid: 'org-1' },
  projects: { '/work/proj': { hasTrustDialogAccepted: true, allowedTools: ['Bash(git:*)'] } },
  theme: 'dark',
}

function freshHome(withFile: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'cfg-unreadable-'))
  mkdirSync(home, { recursive: true })
  if (withFile !== null) writeFileSync(join(home, '.mercury.json'), withFile)
  return home
}

/** Run a scenario body in a fresh process against a scratch home; the body
 *  prints ONE JSON line the scenario asserts on. `seam` installs the
 *  failing fs read for the config path when the body asks for it. */
function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    const path = await import('node:path')
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const fsops = await import(${JSON.stringify(join(SRC, 'utils/fsOperations.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const p = await import(${JSON.stringify(join(SRC, 'utils/config/projectConfig.ts'))})
    const file = env.getGlobalMercuryFile()
    const readDisk = () => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
    const errOf = (e) => e ? { name: e.name, code: e.code ?? null, filePath: e.filePath ?? null, message: String(e.message ?? e) } : null
    // The seam: the product's own fs reads of the config path answer EBUSY
    // (a Windows sharing violation); every other path and every write are
    // untouched, so a save that ignores the failed read still lands on disk.
    const seam = () => {
      const real = fsops.getFsImplementation()
      const busy = () => { const e = new Error('EBUSY: resource busy or locked, open ' + file); e.code = 'EBUSY'; e.errno = -16; e.syscall = 'open'; e.path = file; return e }
      fsops.setFsImplementation(new Proxy(real, {
        get(t, k) {
          if (k === 'readFileSync') return (pth, o) => { if (pth === file) throw busy(); return t.readFileSync(pth, o) }
          return Reflect.get(t, k)
        },
      }))
    }
    const out = {}
    ${body}
    process.stdout.write(JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1200)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}
type Err = { name: string; code: string | null; filePath: string | null; message: string } | null

// ── L1: the boot gate ──────────────────────────────────────────────────────
console.log('L1 boot gate — a present-but-unreadable file throws a typed ConfigReadError')
{
  const home = freshHome(JSON.stringify(REAL_STATE))
  const r = runIn(home, `
    seam()
    try { g.enableConfigs(); out.threw = null } catch (e) { out.threw = errOf(e) }
    out.file = file
  `)
  const threw = r.threw as Err
  check('enableConfigs() throws instead of returning quietly', threw !== null, threw ? '' : 'returned — the boot proceeds as a first run')
  check('the class is ConfigReadError (not ConfigParseError, not a bare errno)', threw?.name === 'ConfigReadError', `name=${threw?.name}`)
  check('it carries the errno code', threw?.code === 'EBUSY', `code=${threw?.code}`)
  check('it names the file', threw?.filePath === r.file, `filePath=${threw?.filePath}`)
  check('the message names the path and the code', !!threw && threw.message.includes(String(r.file)) && threw.message.includes('EBUSY'), threw?.message ?? '')
}

// ── L2: the cache ──────────────────────────────────────────────────────────
console.log('L2 cache — getGlobalConfig() never seeds itself from a failed read')
{
  const home = freshHome(JSON.stringify(REAL_STATE))
  const r = runIn(home, `
    g.enableConfigs()
    seam()
    try { const c = g.getGlobalConfig(); out.r = { threw: null, onboarding: c.hasCompletedOnboarding === true, signedIn: c.oauthAccount !== undefined } }
    catch (e) { out.r = { threw: errOf(e) } }
  `)
  const rr = r.r as { threw: Err; onboarding?: boolean; signedIn?: boolean }
  check('the read refuses (throws ConfigReadError) rather than answering defaults', rr.threw?.name === 'ConfigReadError', rr.threw ? `name=${rr.threw.name}` : `answered onboarding=${rr.onboarding} signedIn=${rr.signedIn} — a returning run painted as a first run`)
}

// ── L3: the save ───────────────────────────────────────────────────────────
console.log('L3 save — saveGlobalConfig refuses on a failed read and leaves the bytes alone')
{
  const home = freshHome(JSON.stringify(REAL_STATE))
  const r = runIn(home, `
    g.enableConfigs()
    seam()
    try { g.getGlobalConfig() } catch {}
    const before = readDisk()
    try { g.saveGlobalConfig(c => ({ ...c, theme: 'light' })); out.saveThrew = null } catch (e) { out.saveThrew = errOf(e) }
    const after = readDisk()
    out.same = before === after
    out.afterParsed = (() => { try { return JSON.parse(after) } catch { return null } })()
  `)
  const after = r.afterParsed as Record<string, unknown> | null
  check('the save does not throw at its caller (a refusal, not a crash)', r.saveThrew === null, r.saveThrew ? `threw ${(r.saveThrew as Err)?.name}` : '')
  check('the file is byte-identical after the refused save', r.same === true, after ? `onboarding=${after.hasCompletedOnboarding} oauth=${after.oauthAccount !== undefined} projects=${JSON.stringify(after.projects)}` : 'file unreadable after')
}

// ── L4: the sibling writer ─────────────────────────────────────────────────
console.log('L4 project slice — saveCurrentProjectConfig refuses the same way')
{
  const home = freshHome(JSON.stringify(REAL_STATE))
  const r = runIn(home, `
    g.enableConfigs()
    seam()
    try { g.getGlobalConfig() } catch {}
    const before = readDisk()
    try { p.saveCurrentProjectConfig(c => ({ ...c, hasTrustDialogAccepted: true })); out.saveThrew = null } catch (e) { out.saveThrew = errOf(e) }
    out.same = before === readDisk()
  `)
  check('the project save does not throw at its caller', r.saveThrew === null, r.saveThrew ? `threw ${(r.saveThrew as Err)?.name}` : '')
  check('the file is byte-identical after the refused project save', r.same === true)
}

// ── L5: controls ───────────────────────────────────────────────────────────
console.log('L5 controls — the absent and corrupt arms are untouched')
{
  const absent = freshHome(null)
  const r = runIn(absent, `
    try { g.enableConfigs(); out.gate = null } catch (e) { out.gate = errOf(e) }
    try { const c = g.getGlobalConfig(); out.read = { threw: null, onboarding: c.hasCompletedOnboarding === true } } catch (e) { out.read = { threw: errOf(e) } }
  `)
  check('absent file: the boot gate does not throw', r.gate === null, r.gate ? `threw ${(r.gate as Err)?.name}` : '')
  const rd = r.read as { threw: Err; onboarding?: boolean }
  check('absent file: defaults are served quietly (a genuine first run)', rd.threw === null && rd.onboarding === false)

  const corrupt = freshHome('{ "hasCompletedOnboarding": true, ')
  const c = runIn(corrupt, `
    try { g.enableConfigs(); out.gate = null } catch (e) { out.gate = errOf(e) }
  `)
  check('corrupt file: the boot gate still throws ConfigParseError', (c.gate as Err)?.name === 'ConfigParseError', `name=${(c.gate as Err)?.name}`)
}

// ── L6: the boot boundary ──────────────────────────────────────────────────
console.log('L6 boot boundary — init.ts refuses by name, never through the reset dialog')
{
  const init = readFileSync(join(SRC, 'entrypoints/init.ts'), 'utf8')
  const at = init.indexOf('instanceof ConfigReadError')
  check('init.ts handles ConfigReadError', at >= 0)
  const arm = at >= 0 ? init.slice(at, at + 1600) : ''
  check('the arm exits non-zero through the graceful shutdown', arm.includes('gracefulShutdownSync(1)'))
  check('the arm names the file and the errno on stderr', arm.includes('process.stderr.write') && arm.includes('.filePath') && arm.includes('.code'))
  const exitAt = arm.indexOf('gracefulShutdownSync(1)')
  check('the reset dialog is not on the unreadable road', at >= 0 && exitAt >= 0 && !arm.slice(0, exitAt).includes('showInvalidConfigDialog'), 'the reset arm sits inside the ConfigReadError block')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
