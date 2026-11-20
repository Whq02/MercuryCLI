#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

function caught(fn: () => unknown): { code: string | null; message: string } | null {
  try {
    fn()
    return null
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    return { code: typeof err?.code === 'string' ? err.code : null, message: String(err?.message ?? error) }
  }
}

{
  console.log('\n1. src/services/vulcan/godotCapsule.ts')
  const { staticGodotCapsule } = await import(join(SRC, 'services/vulcan/godotCapsule.ts'))
  const { derivePresence } = await import(join(SRC, 'services/vulcan/editorPresence.ts'))
  const NO_EDITOR = derivePresence(6010, false, { ok: true, processes: [] }, '/fixture')
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn23-capsule-'))
  try {
    const proj = join(scratch, 'game')
    const scenesDir = join(proj, 'scenes')
    const lockedDir = join(proj, 'locked')
    mkdirSync(scenesDir, { recursive: true })
    mkdirSync(lockedDir, { recursive: true })
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Fixture"\n')
    writeFileSync(join(scenesDir, 'main.tscn'), '[gd_scene format=3]\n')
    writeFileSync(join(lockedDir, 'secret.gd'), 'extends Node\n')

    const clean = staticGodotCapsule(proj, undefined, NO_EDITOR)
    check('godotCapsule: absent export_presets.cfg returns empty list', clean.export_presets.length === 0 && clean.scene_count === 1 && clean.script_count === 1)

    if (!POSIX_MODES) {
      skip('godotCapsule: unreadable subdir', 'requires non-root POSIX')
      skip('godotCapsule: unsearchable subdir statSync', 'requires non-root POSIX')
      skip('godotCapsule: unreadable export_presets.cfg', 'requires non-root POSIX')
    } else {
      chmodSync(lockedDir, 0o000)
      const dirErr = caught(() => staticGodotCapsule(proj, undefined, NO_EDITOR))
      chmodSync(lockedDir, 0o700)
      check('godotCapsule: unreadable subdir throws EACCES instead of low census', dirErr?.code === 'EACCES', JSON.stringify(dirErr))

      chmodSync(lockedDir, 0o400)
      const statErr = caught(() => staticGodotCapsule(proj, undefined, NO_EDITOR))
      chmodSync(lockedDir, 0o700)
      check('godotCapsule: unsearchable subdir statSync throws EACCES instead of skipping', statErr?.code === 'EACCES', JSON.stringify(statErr))

      const presets = join(proj, 'export_presets.cfg')
      writeFileSync(presets, '[preset.0]\nname="Web"\nplatform="Web"\n', { mode: 0o600 })
      chmodSync(presets, 0o200)
      const presetErr = caught(() => staticGodotCapsule(proj, undefined, NO_EDITOR))
      chmodSync(presets, 0o600)
      check('godotCapsule: unreadable export_presets.cfg throws EACCES instead of empty list', presetErr?.code === 'EACCES', JSON.stringify(presetErr))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
