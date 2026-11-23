#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'homefold-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = resolve(import.meta.dir, '..', '..')
const { getProjectDir, foldProjectConfigHomeTail, projectSlug, sanitizePath } = await import(
  join(ROOT, 'src/sessions/transcripts/sessionStoragePortable.ts')
)
const { projectDisplayName } = await import(join(ROOT, 'src/screen/boot-face/bootCardFacts.ts'))
const { getMercuryHome } = await import(join(ROOT, 'src/platform/environment/envUtils.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond && hint) console.log(`         change: ${hint}`)
}

console.log('============================================================')
console.log(' the config-home fold — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'homefold-'))
try {
  const root = join(scratch, 'One Shot Prompt')
  const configHome = join(root, '.mercury')
  mkdirSync(configHome, { recursive: true })
  check('§1 a `.mercury` tail keys to its PARENT (one project, one key)', getProjectDir(configHome) === getProjectDir(root), `${basename(getProjectDir(configHome))} vs ${basename(getProjectDir(root))}`, 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must fold a config-home tail through foldProjectConfigHomeTail before deriving the key')
  check('§1 COHERENCE: the key folds exactly where the ruled naming rule folds — the name and the key can never contradict on one frame', projectDisplayName(configHome) === basename(root) && getProjectDir(configHome) === getProjectDir(root), '', 'projectDisplayName (src/screen/boot-face/bootCardFacts.ts) and getProjectDir (src/sessions/transcripts/sessionStoragePortable.ts) must both fold the config-home tail to the parent')
  check('§1 the pure fold names the parent', foldProjectConfigHomeTail(configHome) === root, '', 'foldProjectConfigHomeTail in src/sessions/transcripts/sessionStoragePortable.ts must return the parent directory of a .mercury tail')
  check('§1 a trailing separator folds the same', getProjectDir(configHome + '/') === getProjectDir(root), '', 'getProjectDir / foldProjectConfigHomeTail in src/sessions/transcripts/sessionStoragePortable.ts must ignore a trailing separator')

  const link = join(scratch, 'door-to-home')
  symlinkSync(configHome, link)
  check('§2 a symlink resolving INTO a config home keys to the parent (the canonical spelling folds too)', getProjectDir(link) === getProjectDir(root), basename(getProjectDir(link)), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must apply the config-home fold to the resolved (realpath) spelling as well')

  check('§3 a root-level config dir stands unfolded (no parent name to wear)', foldProjectConfigHomeTail('/.mercury') === '/.mercury', '', 'foldProjectConfigHomeTail in src/sessions/transcripts/sessionStoragePortable.ts must return /.mercury unchanged when the parent is the filesystem root')
  const selfNamed = join(scratch, '.mercury', '.mercury')
  check('§3 a self-named parent stands unfolded (the naming rule\'s own guard)', foldProjectConfigHomeTail(selfNamed) === selfNamed, '', 'foldProjectConfigHomeTail in src/sessions/transcripts/sessionStoragePortable.ts must not fold a .mercury whose parent is itself named .mercury')

  const sub = join(root, 'csgo-prototype')
  mkdirSync(sub, { recursive: true })
  check('§4 an ordinary subdir still keys to ITSELF (the fold is config-home tails only — folder-as-project stands)', getProjectDir(sub) !== getProjectDir(root) && basename(getProjectDir(sub)).includes('csgo-prototype'), basename(getProjectDir(sub)), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must fold only a .mercury tail, never an ordinary subdirectory')

  const foldRoot = join(scratch, 'folded-project')
  const foldHome = join(foldRoot, '.mercury')
  mkdirSync(foldHome, { recursive: true })
  const projectsDir = join(getMercuryHome(), 'projects')
  const hashless = join(projectsDir, sanitizePath(foldRoot))
  mkdirSync(hashless, { recursive: true })
  writeFileSync(join(hashless, '00000000-0000-0000-0000-000000000002.jsonl'), '')
  try {
    check('§5 the derivation rides the FOLDED spelling: a config-home spelling keys to the PARENT\'s hashed store', getProjectDir(foldHome) === join(projectsDir, projectSlug(realpathSync(foldRoot).normalize('NFC'))), getProjectDir(foldHome), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must derive the hashed projectSlug from the folded parent spelling')
    check('§5 a hash-less directory holding a transcript is not read', getProjectDir(foldHome) !== hashless && getProjectDir(foldRoot) !== hashless, getProjectDir(foldRoot), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must not return a projects directory named by sanitizePath alone, even when it holds a transcript')
  } finally {
    rmSync(hashless, { recursive: true, force: true })
  }

  check('§6 the transcript-home derivation stores a `.mercury`-grounded birth PARENT-side (MERCURY_SESSION_HOME\'s value)', getProjectDir(configHome) === getProjectDir(root) && getProjectDir(configHome).includes(sanitizePath(root).slice(0, 20)), '', 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must key a config-home path to the parent project directory, named from sanitizePath of the parent')
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
  const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
  enableConfigs()
  const { buildConcourseWorkerSpec } = await import(join(ROOT, 'src/daemon/concourse-workers/concourseWorkers.ts'))
  const spawned = buildConcourseWorkerSpec({ runnerId: 'home-fold-proof', workspaceId: configHome, modelKey: 'test-model' }).extraEnv as Record<string, string | undefined>
  check('§6 the spawn hands its worker MERCURY_SESSION_HOME as the folded home of its workspace', spawned.MERCURY_SESSION_HOME === getProjectDir(root), String(spawned.MERCURY_SESSION_HOME), 'buildConcourseWorkerSpec in src/daemon/concourse-workers/spec.ts must set MERCURY_SESSION_HOME to getProjectDir(workspaceId)')
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL CONFIG-HOME FOLD PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
