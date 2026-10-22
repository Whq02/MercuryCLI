import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childAt = process.argv.indexOf('--child')
if (childAt !== -1) {
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { ensureWorkerWorktree } = await import('../../src/daemon/concourseWorktrees.ts')
  const home = process.env.MERCURY_CONFIG_DIR!
  const result = await ensureWorkerWorktree(join(home, 'repo'), 'boundary-worker', join(home, 'daemon'), { branchName: 'fixture-boundary' })
  console.log(JSON.stringify(result))
} else {
  const outer = process.env.MERCURY_CONFIG_DIR
  mkdirSync(outer, { recursive: true })
  const home = mkdtempSync(join(outer, 'worktree-'))
  const repo = join(home, 'repo')
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true' }
  const git = (...args: string[]) => { const out = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }); assert.equal(out.status, 0, out.stderr); return out.stdout }
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
  try {
    mkdirSync(repo)
    mkdirSync(join(home, 'daemon'))
    git('init', '-b', 'main')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nvendor/\n.mercury/\nprivate-fixture.txt\n')
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\n')
    writeFileSync(join(repo, '.worktreeinclude'), 'private-fixture.txt\n')
    git('add', '.gitignore', '.worktreeinclude', 'tracked.txt')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture base\n\nCo-Authored-By: Mercury <https://mercury-cli.ai>')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    mkdirSync(join(repo, 'vendor', 'fixture-pack'), { recursive: true })
    mkdirSync(join(repo, '.mercury'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'fixture-dependency.json'), '{"present":true}\n')
    writeFileSync(join(repo, 'vendor', 'fixture-pack', 'data.json'), '{"present":true}\n')
    writeFileSync(join(repo, '.mercury', 'settings.local.json'), '{"permissions":{"deny":["Bash(fixture-denied)"]}}\n')
    writeFileSync(join(repo, 'private-fixture.txt'), 'included locally\n')
    const configBefore = readFileSync(join(repo, '.git', 'config'), 'utf8')
    const create = () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], { cwd: home, env, encoding: 'utf8', timeout: 30000 })
      assert.equal(child.status, 0, child.stdout + child.stderr)
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result
    }
    const created = create()
    const inspect = () => {
      const child = spawnSync(process.execPath, ['-e', "const fs=require('node:fs');const read=p=>{try{return fs.readFileSync(p,'utf8')}catch{return null}}; console.log(JSON.stringify({dependency:read('node_modules/fixture-dependency.json'),vendor:read('vendor/fixture-pack/data.json'),settings:read('.mercury/settings.local.json'),included:read('private-fixture.txt')}))"], { cwd: created.path, env, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      return JSON.parse(child.stdout.trim())
    }
    const facts = inspect()
    check('a new daemon worktree is created on the requested branch', created.created && created.branchName === 'fixture-boundary')
    check('the fresh worker can read the ignored dependency tree', facts.dependency === '{"present":true}\n')
    check('the fresh worker can read the ignored vendor pack', facts.vendor === '{"present":true}\n')
    check('the fresh worker inherits project-local permission and hook settings', facts.settings === readFileSync(join(repo, '.mercury', 'settings.local.json'), 'utf8'))
    check('the declared worktree include survives the boundary', facts.included === 'included locally\n')
    mkdirSync(join(created.path, '.mercury'), { recursive: true })
    writeFileSync(join(created.path, '.mercury', 'settings.local.json'), '{"permissions":{"deny":["Bash(worker-owned)"]}}\n')
    writeFileSync(join(created.path, 'private-fixture.txt'), 'worker-owned include\n')
    const reused = create()
    const again = inspect()
    check('reusing the same worktree does not replace worker-owned local files', !reused.created && again.settings.includes('worker-owned') && again.included === 'worker-owned include\n')
    check('preparation does not change repository git configuration', readFileSync(join(repo, '.git', 'config'), 'utf8') === configBefore)
    check('the prepared worktree remains free of staged or unstaged tracked changes', git('-C', created.path, 'status', '--porcelain') === '')
    console.log('BOUNDARY WORKTREE ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; real git worktree and separate creator/reader processes')
  } finally { rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
