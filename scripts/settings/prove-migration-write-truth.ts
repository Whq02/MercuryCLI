#!/usr/bin/env bun
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

console.log('L1 A.1 auto-update opt-out — a refused publish changes nothing about it')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const a1 = await import(${JSON.stringify(join(SRC, 'migrations/migrateAutoUpdatesToSettings.ts'))})
    g.saveGlobalConfig(c => ({ ...c, autoUpdates: false }))
    delete process.env.MERCURY_AUTOUPDATE
    out.v1 = a1.migrateAutoUpdatesToSettings()
    await g.flushDeferredGlobalConfigSaves()
    const cfg = JSON.parse(raw(configFile))
    out.autoUpdates = cfg.autoUpdates
    out.envSet = process.env.MERCURY_AUTOUPDATE ?? null
    out.userSettings = raw(userSettingsPath)
  `, { MERCURY_FAULT_INJECT: 'rename@settings.json:eperm' })
  check('A.1 has no settings write to refuse: it reports true', r.v1 === true, `v1=${JSON.stringify(r.v1)}`)
  check('A.1 strips the retired config keys regardless of the settings seam', r.autoUpdates === null || r.autoUpdates === undefined, `autoUpdates=${JSON.stringify(r.autoUpdates)}`)
  check('A.1 arms nothing in the session', r.envSet === null, `MERCURY_AUTOUPDATE=${r.envSet}`)
  check('nothing landed in user settings', r.userSettings === null, String(r.userSettings))
}

console.log('L2 control — with healthy files A.1 strips, relocates nothing and reports true')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const a1 = await import(${JSON.stringify(join(SRC, 'migrations/migrateAutoUpdatesToSettings.ts'))})
    g.saveGlobalConfig(c => ({ ...c, autoUpdates: false }))
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    fs.writeFileSync(userSettingsPath, '{}\\n')
    out.v1 = a1.migrateAutoUpdatesToSettings()
    await g.flushDeferredGlobalConfigSaves()
    const cfg = JSON.parse(raw(configFile))
    out.autoUpdates = cfg.autoUpdates ?? null
    out.user = raw(userSettingsPath)
  `)
  check('A.1: the retired keys are stripped and nothing is relocated', r.user === '{}\n' && r.autoUpdates === null, JSON.stringify({ user: r.user, autoUpdates: r.autoUpdates }))
  check('A.1 reports true (the verdict of a migration with nothing to refuse)', r.v1 === true, JSON.stringify({ v1: r.v1 }))
}

console.log('L3 the runner — the version stamp is gated on every verdict landing')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const start = main.indexOf('function runMigrationsIfNeeded()')
  const body = start >= 0 ? main.slice(start, start + 2600) : ''
  const stampAt = body.indexOf('migrationVersion: MIGRATION_VERSION')
  const gateAt = body.indexOf('landed.some(')
  check('the runner exists', start >= 0)
  check('the runner collects each migration verdict', body.includes('landed.push(migrateAutoUpdatesToSettings())'))
  check('the stamp is present and sits after the incomplete gate', stampAt >= 0 && gateAt >= 0 && gateAt < stampAt, `gate=${gateAt} stamp=${stampAt}`)
  check('an incomplete set withholds the stamp', body.includes('!incomplete &&'))
}

console.log('L4 permission grant — a refused save is reported, never claimed')
{
  const { home, project } = scratch()
  const r = runIn(home, project, `
    const pu = await import(${JSON.stringify(join(SRC, 'utils/permissions/PermissionUpdate.ts'))})
    fs.mkdirSync(path.dirname(localSettingsPath), { recursive: true })
    fs.writeFileSync(localSettingsPath, '{ "guardrails": { "allow": [ ')
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
