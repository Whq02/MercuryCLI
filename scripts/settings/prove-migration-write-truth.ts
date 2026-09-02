#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-migration-write-truth.ts — a startup migration
//  whose settings write did not land keeps its source of truth and reports
//  itself incomplete; a refused permission-rule save says so
//  (release-hardening audit rank 17).
//
//  The class: updateSettingsForSource REFUSES a write when the target file
//  is not parseable JSON (a file mid-edit is never overwritten) or when
//  the atomic publish fails (a transient EPERM/EBUSY hold on Windows), and
//  returns { error } — which every relocating migration discarded before
//  deleting the relocated key from the global config (A.1 the auto-update
//  opt-out, A.2 the dangerous-mode acceptance, A.3 the project MCP
//  approvals) or stamping its own completion or notice (A.4/A.6/A.7 model
//  pins: "your model was updated" while the pin is unchanged). The runner
//  stamped migrationVersion regardless, so the set never ran again and
//  the loss was permanent. The same discarded verdict let a "don't ask
//  again" grant report itself saved while the file never changed.
//
//   L1  A.3 under a mid-edit settings.local.json: the three project-config
//       keys survive, the file is untouched, the migration reports false
//   L2  A.1 and A.2 under a refused user-settings publish (fault-injected
//       rename): the config keys survive, both report false
//   L3  A.4 and A.6 under the same refusal: no notice timestamp, no
//       completion flag, the pin on disk unchanged, both report false
//   L4  controls, healthy files: A.3 relocates and strips, A.1 relocates
//       and strips, A.6 rewrites and stamps — all report true
//   L5  the runner (structural): the version stamp is gated on every
//       verdict landing
//   L6  a permission grant under a mid-edit file: persistPermissionUpdate
//       and persistPermissionUpdates return the refusal; the file is
//       untouched
//
//  Each scenario runs in its own fresh bun subprocess with a scratch
//  MERCURY_CONFIG_DIR and a scratch project directory as the cwd. The
//  refused publish rides the durable writer's fault seam
//  (MERCURY_FAULT_INJECT=rename@settings.json:eperm). PROVE_SRC names
//  another checkout's src (the A/B control: against the pre-fix tree
//  L1–L3, L5 and L6 read red while L4 stays green).
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

function scratch(): { home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'migration-truth-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  return { home, project }
}

/** Run a scenario body in a fresh process; the body prints ONE JSON line. */
function runIn(home: string, project: string, body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const src = `
    process.chdir(${JSON.stringify(project)})
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    const path = await import('node:path')
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const p = await import(${JSON.stringify(join(SRC, 'utils/config/projectConfig.ts'))})
    const s = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    g.enableConfigs()
    const configFile = env.getGlobalMercuryFile()
    const raw = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
    const userSettingsPath = s.getSettingsWriteFilePathForSource('userSettings')
    const localSettingsPath = s.getSettingsWriteFilePathForSource('localSettings')
    const errOf = (e) => e ? { name: e.name, message: String(e.message ?? e) } : null
    const out = { userSettingsPath, localSettingsPath }
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', ...extraEnv },
    cwd: project,
  })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}

// ── L1: A.3 under a mid-edit local settings file ───────────────────────────
console.log('L1 A.3 project MCP approvals — a mid-edit settings.local.json never costs the approvals')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const m = await import(${JSON.stringify(join(SRC, 'migrations/migrateEnableAllProjectMcpServersToSettings.ts'))})
    p.saveCurrentProjectConfig(c => ({ ...c, enableAllProjectMcpServers: true, enabledMcpjsonServers: ['alpha'], disabledMcpjsonServers: ['beta'] }))
    fs.mkdirSync(path.dirname(localSettingsPath), { recursive: true })
    fs.writeFileSync(localSettingsPath, '{ "permissions": { "allow": [ ')
    const before = raw(localSettingsPath)
    out.verdict = m.migrateEnableAllProjectMcpServersToSettings()
    const after = p.getCurrentProjectConfig()
    out.kept = { enableAll: after.enableAllProjectMcpServers, enabled: after.enabledMcpjsonServers, disabled: after.disabledMcpjsonServers }
    out.fileSame = raw(localSettingsPath) === before
  `)
  const kept = r.kept as { enableAll?: boolean; enabled?: string[]; disabled?: string[] }
  check('the migration reports itself incomplete (false)', r.verdict === false, `verdict=${JSON.stringify(r.verdict)}`)
  check('the project-config approvals survive (the source of truth is kept)', kept.enableAll === true && kept.enabled?.[0] === 'alpha' && kept.disabled?.[0] === 'beta', JSON.stringify(kept))
  check('the mid-edit file is untouched', r.fileSame === true)
}

// ── L2: A.1 and A.2 under a refused publish ────────────────────────────────
console.log('L2 A.1 auto-update opt-out and A.2 dangerous-mode acceptance — a refused publish keeps the config keys')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const a1 = await import(${JSON.stringify(join(SRC, 'migrations/migrateAutoUpdatesToSettings.ts'))})
    const a2 = await import(${JSON.stringify(join(SRC, 'migrations/migrateBypassPermissionsAcceptedToSettings.ts'))})
    g.saveGlobalConfig(c => ({ ...c, autoUpdates: false, bypassPermissionsModeAccepted: true }))
    delete process.env.DISABLE_AUTOUPDATER
    out.v1 = a1.migrateAutoUpdatesToSettings()
    out.v2 = a2.migrateBypassPermissionsAcceptedToSettings()
    const cfg = JSON.parse(raw(configFile))
    out.autoUpdates = cfg.autoUpdates
    out.accepted = cfg.bypassPermissionsModeAccepted
    out.envSet = process.env.DISABLE_AUTOUPDATER ?? null
    out.userSettings = raw(userSettingsPath)
  `, { MERCURY_FAULT_INJECT: 'rename@settings.json:eperm' })
  check('A.1 reports itself incomplete', r.v1 === false, `v1=${JSON.stringify(r.v1)}`)
  check('A.1 keeps autoUpdates:false in the config', r.autoUpdates === false, `autoUpdates=${JSON.stringify(r.autoUpdates)}`)
  check('A.1 does not arm the in-session opt-out for a write that did not land', r.envSet === null, `DISABLE_AUTOUPDATER=${r.envSet}`)
  check('A.2 reports itself incomplete', r.v2 === false, `v2=${JSON.stringify(r.v2)}`)
  check('A.2 keeps bypassPermissionsModeAccepted in the config', r.accepted === true, `accepted=${JSON.stringify(r.accepted)}`)
  check('nothing landed in user settings', r.userSettings === null || !String(r.userSettings).includes('DISABLE_AUTOUPDATER'), String(r.userSettings))
}

// ── L3: A.4 and A.6 under a refused publish ────────────────────────────────
console.log('L3 A.4 legacy Opus pin and A.6 sonnet[1m] pin — no notice, no completion flag for a write that did not land')
{
  // Two fresh processes: the settings loader memoizes per process, so each
  // pin is seeded before its migration's first read.
  const a = scratch()
  const r4 = runIn(a.home, a.project, `
    const a4 = await import(${JSON.stringify(join(SRC, 'migrations/migrateLegacyOpusToCurrent.ts'))})
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    fs.writeFileSync(userSettingsPath, JSON.stringify({ model: 'claude-opus-4-1' }, null, 2) + '\\n')
    const before4 = raw(userSettingsPath)
    out.v4 = a4.migrateLegacyOpusToCurrent()
    out.pin4Same = raw(userSettingsPath) === before4
    const cfg = JSON.parse(raw(configFile) ?? '{}')
    out.opusStamp = cfg.legacyOpusMigrationTimestamp ?? null
  `, { MERCURY_FAULT_INJECT: 'rename@settings.json:eperm' })
  const b = scratch()
  const r6 = runIn(b.home, b.project, `
    const a6 = await import(${JSON.stringify(join(SRC, 'migrations/migrateSonnet1mToSonnet45.ts'))})
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    fs.writeFileSync(userSettingsPath, JSON.stringify({ model: 'sonnet[1m]' }, null, 2) + '\\n')
    const before6 = raw(userSettingsPath)
    out.v6 = a6.migrateSonnet1mToSonnet45()
    out.pin6Same = raw(userSettingsPath) === before6
    const cfg = JSON.parse(raw(configFile) ?? '{}')
    out.sonnetFlag = cfg.sonnet1m45MigrationComplete ?? null
  `, { MERCURY_FAULT_INJECT: 'rename@settings.json:eperm' })
  const r = { ...r4, ...r6 }
  check('A.4 reports itself incomplete', r.v4 === false, `v4=${JSON.stringify(r.v4)}`)
  check('A.4 stamps no "model updated" notice', r.opusStamp === null, `legacyOpusMigrationTimestamp=${r.opusStamp}`)
  check('A.4 leaves the pin on disk unchanged', r.pin4Same === true)
  check('A.6 reports itself incomplete', r.v6 === false, `v6=${JSON.stringify(r.v6)}`)
  check('A.6 leaves its completion flag unset (retries next boot)', r.sonnetFlag === null, `sonnet1m45MigrationComplete=${r.sonnetFlag}`)
  check('A.6 leaves the pin on disk unchanged', r.pin6Same === true)
}

// ── L4: controls — healthy files ───────────────────────────────────────────
console.log('L4 controls — with healthy files every migration relocates, strips and reports true')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const a1 = await import(${JSON.stringify(join(SRC, 'migrations/migrateAutoUpdatesToSettings.ts'))})
    const a3 = await import(${JSON.stringify(join(SRC, 'migrations/migrateEnableAllProjectMcpServersToSettings.ts'))})
    const a6 = await import(${JSON.stringify(join(SRC, 'migrations/migrateSonnet1mToSonnet45.ts'))})
    g.saveGlobalConfig(c => ({ ...c, autoUpdates: false }))
    p.saveCurrentProjectConfig(c => ({ ...c, enabledMcpjsonServers: ['alpha'] }))
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    fs.writeFileSync(userSettingsPath, JSON.stringify({ model: 'sonnet[1m]' }, null, 2) + '\\n')
    out.v1 = a1.migrateAutoUpdatesToSettings()
    out.v3 = a3.migrateEnableAllProjectMcpServersToSettings()
    out.v6 = a6.migrateSonnet1mToSonnet45()
    const cfg = JSON.parse(raw(configFile))
    out.autoUpdates = cfg.autoUpdates ?? null
    out.sonnetFlag = cfg.sonnet1m45MigrationComplete ?? null
    out.projectEnabled = p.getCurrentProjectConfig().enabledMcpjsonServers ?? null
    out.local = JSON.parse(raw(localSettingsPath) ?? '{}')
    out.user = JSON.parse(raw(userSettingsPath) ?? '{}')
  `)
  // The behavioural halves are green on both trees (the healthy road always
  // worked); the verdicts are the fix.
  check('A.1: relocated (user settings carries the opt-out) and stripped', (r.user as { env?: Record<string, string> }).env?.DISABLE_AUTOUPDATER === '1' && r.autoUpdates === null, JSON.stringify({ user: r.user, autoUpdates: r.autoUpdates }))
  check('A.3: relocated (local settings carries the approvals) and stripped', (r.local as { enabledMcpjsonServers?: string[] }).enabledMcpjsonServers?.[0] === 'alpha' && r.projectEnabled === null, JSON.stringify({ local: r.local, projectEnabled: r.projectEnabled }))
  check('A.6: rewrote the pin and stamped completion', (r.user as { model?: string }).model === 'sonnet-4-5-20250929[1m]' && r.sonnetFlag === true, JSON.stringify({ model: (r.user as { model?: string }).model, flag: r.sonnetFlag }))
  check('all three report true (the verdict of a landed write)', r.v1 === true && r.v3 === true && r.v6 === true, JSON.stringify({ v1: r.v1, v3: r.v3, v6: r.v6 }))
}

// ── L5: the runner (structural) ────────────────────────────────────────────
console.log('L5 the runner — the version stamp is gated on every verdict landing')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const start = main.indexOf('function runMigrationsIfNeeded()')
  const body = start >= 0 ? main.slice(start, start + 2600) : ''
  const stampAt = body.indexOf('migrationVersion: MIGRATION_VERSION')
  const gateAt = body.indexOf('landed.some(')
  check('the runner exists', start >= 0)
  check('the runner collects each migration verdict', body.includes('landed.push(migrateEnableAllProjectMcpServersToSettings())'))
  check('the stamp is present and sits after the incomplete gate', stampAt >= 0 && gateAt >= 0 && gateAt < stampAt, `gate=${gateAt} stamp=${stampAt}`)
  check('an incomplete set withholds the stamp', body.includes('!incomplete &&'))
}

// ── L6: a permission grant under a mid-edit file ───────────────────────────
console.log('L6 permission grant — a refused save is reported, never claimed')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const pu = await import(${JSON.stringify(join(SRC, 'utils/permissions/PermissionUpdate.ts'))})
    fs.mkdirSync(path.dirname(localSettingsPath), { recursive: true })
    fs.writeFileSync(localSettingsPath, '{ "permissions": { "allow": [ ')
    const before = raw(localSettingsPath)
    const update = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }], behavior: 'allow', destination: 'localSettings' }
    const one = pu.persistPermissionUpdate(update)
    const many = pu.persistPermissionUpdates([update, { ...update, destination: 'session' }])
    out.one = one === undefined ? 'void' : errOf(one.error)
    out.many = many === undefined ? 'void' : errOf(many.error)
    out.fileSame = raw(localSettingsPath) === before
  `)
  const one = r.one as { message: string } | null | 'void'
  const many = r.many as { message: string } | null | 'void'
  check('persistPermissionUpdate returns the refusal', one !== 'void' && one !== null && one.message.includes('refusing'), JSON.stringify(one))
  check('persistPermissionUpdates carries the first refusal', many !== 'void' && many !== null && many.message.includes('refusing'), JSON.stringify(many))
  check('the mid-edit file is untouched', r.fileSame === true)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
