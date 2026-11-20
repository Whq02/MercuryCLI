#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchHome = mkdtempSync(join(tmpdir(), 'faults-fn05-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function throwsWithCode(fn: () => unknown, codes: readonly string[]): { threw: boolean; code: string | undefined; message: string } {
  try {
    fn()
    return { threw: false, code: undefined, message: '' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { threw: true, code, message: error instanceof Error ? error.message : String(error) }
  }
}

{
  const { hashTree, treeFileDigests, folderSize } = await import('../../src/extensions/tree.ts')
  const dir = mkdtempSync(join(tmpdir(), 'faults-fn05-tree-'))
  try {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'root.txt'), 'root')
    writeFileSync(join(dir, 'sub', 'hidden.txt'), 'secret')
    if (POSIX_MODES) {
      chmodSync(join(dir, 'sub'), 0o000)
      try {
        const hashRes = throwsWithCode(() => hashTree(dir), ['EACCES', 'EPERM'])
        const digestsRes = throwsWithCode(() => treeFileDigests(dir), ['EACCES', 'EPERM'])
        const size = folderSize(dir)
        check('tree: hashTree throws on unreadable subfolder', hashRes.threw && (hashRes.code === 'EACCES' || hashRes.code === 'EPERM'), JSON.stringify(hashRes))
        check('tree: treeFileDigests throws on unreadable subfolder', digestsRes.threw && (digestsRes.code === 'EACCES' || digestsRes.code === 'EPERM'), JSON.stringify(digestsRes))
        check('tree: folderSize stays best-effort on unreadable subfolder', size === 4, String(size))
      } finally {
        chmodSync(join(dir, 'sub'), 0o700)
      }
    }
    const missingHash = hashTree(join(dir, 'absent'))
    check('tree: hashTree still treats missing root as empty', missingHash.startsWith('sha256:'), missingHash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { generatedAssetsRefusal } = await import('../../src/guards/commitGate.ts')
  const { GENERATED_ASSETS_MAP } = await import('../../src/guards/generatedAssets.ts')
  const repo = mkdtempSync(join(tmpdir(), 'faults-fn05-commitgate-'))
  try {
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' } })
    }
    git('init')
    mkdirSync(join(repo, 'scripts/gate'), { recursive: true })
    writeFileSync(join(repo, GENERATED_ASSETS_MAP), 'out.txt\tgen.ts\t-\tre:TRIGGER_TOKEN\n')
    writeFileSync(join(repo, 'src.txt'), 'initial\n')
    writeFileSync(join(repo, 'out.txt'), 'out\n')
    git('add', '.')
    git('commit', '-m', 'init')
    writeFileSync(join(repo, 'src.txt'), 'TRIGGER_TOKEN\n')
    git('add', 'src.txt')
    if (POSIX_MODES) {
      chmodSync(join(repo, 'src.txt'), 0o000)
      try {
        let threw = false
        let refusal: string | null = null
        try {
          refusal = generatedAssetsRefusal('git commit -m "upd" -- src.txt', repo)
        } catch {
          threw = true
        }
        check('commitGate: unreadable commit candidate refuses instead of passing open', threw || refusal !== null, `threw=${threw} refusal=${String(refusal)}`)
      } finally {
        chmodSync(join(repo, 'src.txt'), 0o600)
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
