#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

function runIn(body: string): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-guard-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.chdir(${JSON.stringify(project)})
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const fs = await import('node:fs')
    const path = await import('node:path')
    const home = ${JSON.stringify(home)}
    const project = ${JSON.stringify(project)}
    const s = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    const userSettingsPath = s.getSettingsFilePathForSource('userSettings')
    const plantOldDebugLog = () => {
      const debugDir = path.join(home, 'debug')
      fs.mkdirSync(debugDir, { recursive: true })
      const file = path.join(debugDir, 'old-session.txt')
      fs.writeFileSync(file, 'keep me')
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      fs.utimesSync(file, old, old)
      return file
    }
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' }, cwd: project })
  try {
    if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('L1 the probe — unknown answers yes')
{
  const r = runIn(`
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    out.absent = s.rawSettingsContainsKey('records.retentionDays')
    fs.writeFileSync(userSettingsPath, '')
    out.empty = s.rawSettingsContainsKey('records.retentionDays')
    fs.writeFileSync(userSettingsPath, '{ "records": { "retentionDays": 365, ')
    out.unparseable = s.rawSettingsContainsKey('records.retentionDays')
    fs.writeFileSync(userSettingsPath, JSON.stringify({ theme: 'dark', records: {} }))
    out.withoutKey = s.rawSettingsContainsKey('records.retentionDays')
    fs.writeFileSync(userSettingsPath, JSON.stringify({ records: { retentionDays: 365 } }))
    out.withKey = s.rawSettingsContainsKey('records.retentionDays')
    if (process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
      fs.chmodSync(userSettingsPath, 0o000)
      out.unreadable = s.rawSettingsContainsKey('records.retentionDays')
      fs.chmodSync(userSettingsPath, 0o600)
    } else {
      out.unreadable = 'skipped'
    }
  `)
  check('an absent file answers false', r.absent === false)
  check('an empty file answers false', r.empty === false)
  check('an UNPARSEABLE file answers true (the key may be there)', r.unparseable === true, `answered ${r.unparseable}`)
  check('a parseable file without the key answers false', r.withoutKey === false)
  check('a parseable file with the key answers true', r.withKey === true)
  check('an UNREADABLE file answers true', r.unreadable === true || r.unreadable === 'skipped', `answered ${r.unreadable}`)
}

console.log('L2 the sweep — a broken settings file that held the key stops the sweep')
{
  const r = runIn(`
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    fs.writeFileSync(userSettingsPath, '{ "records": { "retentionDays": 365, ')
    const planted = plantOldDebugLog()
    const cleanup = await import(${JSON.stringify(join(SRC, 'utils/cleanup.ts'))})
    out.receipt = await cleanup.cleanupOldMessageFilesInBackground()
    out.survived = fs.existsSync(planted)
  `)
  const receipt = r.receipt as { messages: number; errors: number }
  check('the 40-day-old debug log SURVIVES', r.survived === true, 'the sweep deleted it on the 30-day default')
  check('the receipt carries one error and no finished look', receipt.errors === 1 && receipt.messages === 0, JSON.stringify(receipt))
}

console.log('L3 control — healthy settings, the sweep runs')
{
  const r = runIn(`
    fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true })
    fs.writeFileSync(userSettingsPath, JSON.stringify({ theme: 'dark' }))
    const planted = plantOldDebugLog()
    const cleanup = await import(${JSON.stringify(join(SRC, 'utils/cleanup.ts'))})
    out.receipt = await cleanup.cleanupOldMessageFilesInBackground()
    out.survived = fs.existsSync(planted)
  `)
  check('the old debug log is swept on the default window', r.survived === false, 'still present')
}

console.log('L4 policy — a registry/plist-delivered retention window is seen')
{
  const r = runIn(`
    const raw = await import(${JSON.stringify(join(SRC, 'utils/settings/mdm/rawRead.ts'))})
    const mdm = await import(${JSON.stringify(join(SRC, 'utils/settings/mdm/settings.ts'))})
    if (typeof raw._setMdmRawReadForProofs !== 'function') { out.skipped = true }
    else {
      raw._setMdmRawReadForProofs({ plistStdouts: [{ stdout: JSON.stringify({ records: { retentionDays: 365 } }), label: 'proof plist' }], hklmStdout: null, hkcuStdout: null })
      await mdm.ensureMdmSettingsLoaded()
      out.viaPolicy = s.rawSettingsContainsKey('records.retentionDays')
    }
  `)
  if (r.skipped === true) check('the policy tier is probed', false, 'the proof seam is absent in this src (pre-fix tree)')
  else check('the policy tier is probed (the key seen through the parsed view)', r.viaPolicy === true, `answered ${r.viaPolicy}`)
}

console.log('L5 oversized retention never deletes pasted images or worktrees')
for (const road of ['settings', 'runtime', 'invalid-cutoff']) {
  const r = runIn(`
    globalThis.MACRO = { VERSION: '1.0.0' }
    fs.writeFileSync(userSettingsPath, JSON.stringify({ records: { retentionDays: 1e12 } }))
    const image = path.join(home, 'image-cache', 'another-session', '1.png')
    fs.mkdirSync(path.dirname(image), { recursive: true })
    fs.writeFileSync(image, 'keep this image')
    const oldLog = plantOldDebugLog()
    const { spawnSync } = await import('node:child_process')
    const git = args => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    }
    git(['init', '-q'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
    const tree = path.join(project, '.mercury', 'worktrees', 'agent-a123456789abcdef0')
    git(['worktree', 'add', '-qb', 'worktree-agent-a123456789abcdef0', tree])
    const age = new Date(Date.now() - 10 * 86_400_000)
    fs.utimesSync(tree, age, age)
    const schema = (await import(${JSON.stringify(join(SRC, 'utils/settings/types.ts'))})).SettingsSchema()
    const parsed = schema.safeParse({ records: { retentionDays: 1e12 } })
    out.refused = !parsed.success && parsed.error.issues.some(i => i.path.join('.') === 'records.retentionDays' && /at most|maximum/.test(i.message))
    if (${JSON.stringify(road)} === 'runtime') {
      const { mock } = await import('bun:test')
      const all = await import(${JSON.stringify(join(SRC, 'utils/settings/allErrors.ts'))})
      mock.module(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))}, () => ({ ...s, getInitialSettings: () => ({ records: { retentionDays: 1e12 } }) }))
      mock.module(${JSON.stringify(join(SRC, 'utils/settings/allErrors.ts'))}, () => ({ ...all, getSettingsWithAllErrors: () => ({ settings: {}, errors: [] }) }))
    }
    const cleanup = await import(${JSON.stringify(join(SRC, 'utils/cleanup.ts'))})
    if (${JSON.stringify(road)} === 'invalid-cutoff') {
      const images = await import(${JSON.stringify(join(SRC, 'utils/imageStore.ts'))})
      const trees = await import(${JSON.stringify(join(SRC, 'utils/worktree.ts'))})
      await images.cleanupOldImageCaches(new Date(NaN))
      await trees.cleanupStaleAgentWorktrees(new Date(NaN))
    } else out.receipt = await cleanup.cleanupOldMessageFilesInBackground()
    out.image = fs.existsSync(image) && fs.readFileSync(image, 'utf8') === 'keep this image'
    out.tree = fs.existsSync(tree)
    out.log = fs.existsSync(oldLog)
  `)
  check(`${road}: oversized retention is refused by name`, r.refused === true)
  check(`${road}: another session's pasted image survives`, r.image === true)
  check(`${road}: the ten-day-old clean worktree survives`, r.tree === true)
  check(`${road}: the old debug log survives`, r.log === true)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
