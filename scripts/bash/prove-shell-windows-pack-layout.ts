#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('── §1 the hosted probe workflow ──')
const PROBE = '.github/workflows/shell-windows-probe.yml'
let pinnedVersion = ''
{
  const yml = read(PROBE)
  check('dispatch-only: workflow_dispatch with an exact-sha input', /^on:\n  workflow_dispatch:\n    inputs:\n      sha:/m.test(yml))
  check('never on push or pull_request', !/^\s*(push|pull_request):/m.test(yml))
  check('runs on windows-latest under pwsh', yml.includes('runs-on: windows-latest') && yml.includes('shell: pwsh'))
  check('the pinned Node from .node-version', yml.includes('node-version-file: .node-version'))
  check('bun 1.3.11 (the build runtime)', yml.includes('bun-version: 1.3.11'))
  const version = /brush_version:[\s\S]*?default: '([^']+)'/.exec(yml)?.[1] ?? ''
  pinnedVersion = version
  check('the engine version is a pinned default', /^\d+\.\d+\.\d+$/.test(version), version)
  check('the engine is BUILT natively with cargo at that version', yml.includes('cargo install --locked brush-shell --version $env:BRUSH_VERSION'))
  check('the engine smoke runs the built binary', yml.includes('$env:BRUSH_EXE') && yml.includes("-c 'x=41; f()"))
  check('the doctor runs with bash.exe present', /Doctor with bash\.exe PRESENT/.test(yml) && yml.includes('doctor --json'))
  check('the doctor runs with bash.exe ABSENT — the real rename, restored in a finally', yml.includes("Rename-Item -Path $bash -NewName 'bash.exe.off'") && /finally \{[\s\S]*?Rename-Item -Path "\$bash\.off" -NewName 'bash\.exe'/.test(yml))
  check('…and pins the shell check to warn', yml.includes("if ($shell.status -ne 'warn')"))
  check('the pin-that-points-nowhere arm expects exit 1', yml.includes("$env:MERCURY_GIT_BASH_PATH = 'C:\\nowhere\\bash.exe'") && yml.includes('if ($code -ne 1)'))
  check('the road prover and this prover run on the box', yml.includes('bun scripts/bash/prove-windows-shell-road.ts') && yml.includes('bun scripts/bash/prove-shell-windows-pack-layout.ts'))
  check('the pack script is consumed when the tree carries it (never a hard dependency of the probe)', yml.includes('Test-Path scripts/vendor/build-brush.ts'))
}

console.log('── §2 the release windows job ──')
{
  const yml = read('.github/workflows/private-release.yml')
  const step = yml.indexOf('- name: Build the shell engine pack (Windows)')
  check('the package job carries the Windows engine-pack step', step !== -1)
  const body = step === -1 ? '' : yml.slice(step, step + 400)
  check('…on the Windows row only', body.includes("if: runner.os == 'Windows'"))
  check('…optional — a toolchain failure never sinks the archive', body.includes('continue-on-error: true'))
  check('…through the pack build script', body.includes('run: bun run scripts/vendor/build-brush.ts'))
  check('the windows-x64 target row exists', yml.includes('target: windows-x64') && yml.includes('os: windows-latest'))
}

console.log('── §3 the win32-x64 layout ──')
{
  const lock = join(ROOT, 'vendor', 'brush.lock.json')
  if (existsSync(lock)) {
    const parsed = JSON.parse(readFileSync(lock, 'utf8')) as { version?: string }
    check('the engine pin (vendor/brush.lock.json) equals the probe\'s default version', parsed.version === pinnedVersion, `${parsed.version} vs ${pinnedVersion}`)
  } else {
    console.log('  [SKIP] vendor/brush.lock.json is not on this tree — the version pin is the probe\'s default alone')
  }
  const pack = join(ROOT, 'vendor', 'brush', 'win32-x64')
  if (!existsSync(pack)) {
    console.log('  [SKIP] no vendor/brush/win32-x64 pack on this host — the layout leg runs where the pack is built (the hosted probe, a Windows box)')
  } else {
    const exe = join(pack, 'brush.exe')
    check('brush.exe is present', existsSync(exe) && statSync(exe).size > 0)
    const manifestPath = join(pack, '.vendor-manifest.json')
    check('.vendor-manifest.json is present', existsSync(manifestPath))
    if (existsSync(manifestPath) && existsSync(exe)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      check('the manifest names the platform win32-x64', manifest.platform === 'win32-x64', String(manifest.platform))
      check('the manifest carries a version', typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), String(manifest.version))
      const digest = createHash('sha256').update(readFileSync(exe)).digest('hex')
      const strings: string[] = []
      const walk = (v: unknown): void => {
        if (typeof v === 'string') strings.push(v)
        else if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
      }
      walk(manifest)
      check('the manifest carries the binary\'s sha256', strings.includes(digest), digest.slice(0, 16))
    }
    check('NOTICES.json is present', existsSync(join(pack, 'NOTICES.json')))
    const licenses = join(pack, 'licenses')
    check('licenses/ is present and non-empty (the pack law: licence preserved)', existsSync(licenses) && readdirSync(licenses).length > 0)
  }
}

console.log(failures === 0 ? '\n✅ SHELL WINDOWS PACK LAYOUT PROOF PASS' : `\n❌ SHELL WINDOWS PACK LAYOUT PROOF RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
