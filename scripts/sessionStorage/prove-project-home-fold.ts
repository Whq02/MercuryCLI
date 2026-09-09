#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { codeOnlyText } from '../lib/codeText.ts'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'homefold-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = resolve(import.meta.dir, '..', '..')
const { getProjectDir, foldProjectConfigHomeTail, sanitizePath } = await import(
  join(ROOT, 'src/utils/sessionStoragePortable.ts')
)
const { projectDisplayName } = await import(join(ROOT, 'src/utils/bootCardFacts.ts'))
const { getMercuryHome } = await import(join(ROOT, 'src/utils/envUtils.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' the config-home fold — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'homefold-'))
try {
  const root = join(scratch, 'One Shot Prompt')
  const configHome = join(root, '.mercury')
  mkdirSync(configHome, { recursive: true })
  check('§1 a `.mercury` tail keys to its PARENT (one project, one key)', getProjectDir(configHome) === getProjectDir(root), `${basename(getProjectDir(configHome))} vs ${basename(getProjectDir(root))}`)
  check('§1 COHERENCE: the key folds exactly where the ruled naming rule folds — the name and the key can never contradict on one frame', projectDisplayName(configHome) === basename(root) && getProjectDir(configHome) === getProjectDir(root))
  check('§1 the pure fold names the parent', foldProjectConfigHomeTail(configHome) === root)
  check('§1 a trailing separator folds the same', getProjectDir(configHome + '/') === getProjectDir(root))

  const link = join(scratch, 'door-to-home')
  symlinkSync(configHome, link)
  check('§2 a symlink resolving INTO a config home keys to the parent (the canonical spelling folds too)', getProjectDir(link) === getProjectDir(root), basename(getProjectDir(link)))

  check('§3 a root-level config dir stands unfolded (no parent name to wear)', foldProjectConfigHomeTail('/.mercury') === '/.mercury')
  const selfNamed = join(scratch, '.mercury', '.mercury')
  check('§3 a self-named parent stands unfolded (the naming rule\'s own guard)', foldProjectConfigHomeTail(selfNamed) === selfNamed)

  const sub = join(root, 'csgo-prototype')
  mkdirSync(sub, { recursive: true })
  check('§4 an ordinary subdir still keys to ITSELF (the fold is config-home tails only — folder-as-project stands)', getProjectDir(sub) !== getProjectDir(root) && basename(getProjectDir(sub)).includes('csgo-prototype'), basename(getProjectDir(sub)))

  const legacyRoot = join(scratch, 'legacy-era-project')
  const legacyHome = join(legacyRoot, '.mercury')
  mkdirSync(legacyHome, { recursive: true })
  const projectsDir = join(getMercuryHome(), 'projects')
  const legacyStore = join(projectsDir, sanitizePath(legacyRoot))
  mkdirSync(legacyStore, { recursive: true })
  writeFileSync(join(legacyStore, '00000000-0000-0000-0000-000000000002.jsonl'), '')
  try {
    check('§5 the adoption ladder rides the FOLDED spelling: a config-home spelling adopts the PARENT\'s legacy store in place', getProjectDir(legacyHome) === legacyStore, getProjectDir(legacyHome))
  } finally {
    rmSync(legacyStore, { recursive: true, force: true })
  }

  check('§6 the transcript-home derivation stores a `.mercury`-grounded birth PARENT-side (MERCURY_SESSION_HOME\'s value)', getProjectDir(configHome) === getProjectDir(root) && getProjectDir(configHome).includes(sanitizePath(root).slice(0, 20)))
  const supervisor = codeOnlyText('src/daemon/concourseSupervisor.ts', readFileSync(join(ROOT, 'src/daemon/concourseSupervisor.ts'), 'utf8'))
  const daemonPaths = codeOnlyText('src/utils/sessionStorage/paths.ts', readFileSync(join(ROOT, 'src/utils/sessionStorage/paths.ts'), 'utf8'))
  check('§6 SOURCE SEAM: the spawn sets MERCURY_SESSION_HOME via getProjectDir(args.workspaceId)', supervisor.includes('MERCURY_SESSION_HOME: getProjectDir(args.workspaceId)') && supervisor.includes("import { getProjectDir } from '../utils/sessionStorage/paths.js'"))
  check('§6 SOURCE SEAM: that getProjectDir IS the folding derivation proved above (paths delegates to the portable resolver)', daemonPaths.includes("import { getProjectDir as resolveProjectDirWithAdoption } from '../sessionStoragePortable.js'") && daemonPaths.includes('return resolveProjectDirWithAdoption(projectDir)'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL CONFIG-HOME FOLD PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
