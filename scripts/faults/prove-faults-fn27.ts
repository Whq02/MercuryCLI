import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const rootScratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn27-')))
const scratchHome = join(rootScratch, 'home')
mkdirSync(scratchHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

function runIsolated(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fn27-iso-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SRC = ${JSON.stringify(SRC)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      timeout: 30_000,
    })
    if (res.status !== 0) throw new Error(`isolated failed (rc ${res.status}): ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  {
    const { prepareApply } = await import(join(SRC, 'tools/LSPTool/mercuryOps/prepare.ts'))
    const dir = join(rootScratch, 'prepare-case')
    mkdirSync(dir, { recursive: true })
    const fileAsParent = join(dir, 'blocker')
    writeFileSync(fileAsParent, 'not a dir')
    const blockedPath = join(fileAsParent, 'child.ts')
    const env = { cwd: dir, absolutePath: blockedPath, manager: {}, input: {}, tool: {}, context: {} } as never
    const res = await prepareApply(
      env,
      async () => ({ documentChanges: [{ kind: 'create', uri: pathToFileURL(blockedPath).href }] }),
      { allowCreate: true },
    )
    check(
      'prepare-create-non-enoent: ENOTDIR from stat refuses create instead of treating path as absent',
      res.ok === false && !res.reason.includes('already exists') && /ENOTDIR|not a directory|could not/i.test(res.reason),
      JSON.stringify(res),
    )
    if (POSIX_MODES) {
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      const hidden = join(locked, 'new.ts')
      chmodSync(locked, 0o000)
      try {
        const resAcc = await prepareApply(
          env,
          async () => ({ documentChanges: [{ kind: 'create', uri: pathToFileURL(hidden).href }] }),
          { allowCreate: true },
        )
        check(
          'prepare-create-non-enoent: EACCES from stat refuses create instead of treating path as absent',
          resAcc.ok === false && !resAcc.reason.includes('already exists') && /EACCES|permission denied|could not/i.test(resAcc.reason),
          JSON.stringify(resAcc),
        )
      } finally {
        chmodSync(locked, 0o700)
      }
    }
  }
} finally {
  rmSync(rootScratch, { recursive: true, force: true })
}

void runIsolated
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
