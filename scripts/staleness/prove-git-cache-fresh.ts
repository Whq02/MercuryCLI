import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitArgs, gitArgsAsync } from '../../src/utils/git/spawnArgs.ts'

const scratch = mkdtempSync(join(tmpdir(), 'git-cache-fresh-'))
const init = (root: string): void => {
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' })
}
const filter = (root: string, name: string): string => {
  const path = join(root, `${name}.sh`)
  appendFileSync(join(root, '.git', 'config'), `\n[filter "${name}"]\n clean = "${path}"\n`)
  return path
}
let failures = 0
const check = (name: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) failures++
}
try {
  for (const [road, argsOf] of [['sync', gitArgs], ['async', gitArgsAsync]] as const) {
    const root = join(scratch, road)
    init(root)
    const executable = filter(root, 'fresh')
    assert.ok(!(await argsOf(['add', '--', 'file.txt'], root)).includes('filter.fresh.clean='))
    writeFileSync(executable, 'exit 0\n')
    check(`${road}: a helper created after the config cache warmed is still suppressed`, (await argsOf(['add', '--', 'file.txt'], root)).includes('filter.fresh.clean='))
    rmSync(executable)
    check(`${road}: a removed helper no longer claims to be present`, !(await argsOf(['add', '--', 'file.txt'], root)).includes('filter.fresh.clean='))

    const nested = join(root, 'nested')
    mkdirSync(nested)
    await argsOf(['add', '--', 'file.txt'], nested)
    init(nested)
    writeFileSync(filter(nested, 'nearer'), 'exit 0\n')
    check(`${road}: creating a nearer repository invalidates the old layout while its directories still exist`, (await argsOf(['add', '--', 'file.txt'], nested)).includes('filter.nearer.clean='))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
assert.equal(failures, 0, `${failures} stale Git facts survived a filesystem change`)
