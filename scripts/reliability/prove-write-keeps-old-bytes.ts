#!/usr/bin/env bun
// ============================================================================
//  scripts/reliability/prove-write-keeps-old-bytes.ts — a write that cannot
//  land leaves the old bytes intact and refuses typed (FN-015 rank 3).
//
//  writeFileSyncAndFlush_DEPRECATED is the sync atomic writer behind every
//  file tool (writeTextContent) and the global-config publish. Its fallback
//  arm opened the destination with the truncating default flag whenever the
//  temp write or the rename failed — so a volume out of space (EROFS, EIO,
//  EDQUOT behave the same) left the user's source file at ZERO bytes with its
//  previous contents gone, and nothing to restore from.
//
//  §1 the pure fallback classifier (both platforms, table-provable here)
//  §2 injected structural failures at the rename (ENOSPC · EROFS · EIO ·
//     EDQUOT): a typed AtomicWriteRefusal naming the file, the old bytes
//     byte-identical, no temp residue
//  §3 injected ENOSPC at the temp write: the same contract
//  §4 the guarded direct write (POSIX, non-root): a directory that refuses
//     a sibling but a file that accepts the write still lands the new
//     content; a write that fails midway RESTORES the old bytes and refuses
//  §5 LIVE (macOS): a real out-of-space volume — a 1 MiB disk image filled
//     to ENOSPC — the audit's exact shape; skipped by name elsewhere
//  §6 the writer keeps no truncating fallback (source pin)
//
//  Run:  ~/.bun/bin/bun run scripts/reliability/prove-write-keeps-old-bytes.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the atomic writer keeps the old bytes when the write cannot land')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'prove-write-keeps-old-bytes-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

const fileMod = (await import('../../src/utils/file.ts')) as Record<string, unknown>
const write = fileMod.writeFileSyncAndFlush_DEPRECATED as (p: string, c: string, o?: { encoding?: BufferEncoding; mode?: number }) => void
const classify = fileMod.classifyAtomicWriteFailure as
  | ((code: string | undefined, facts: { platform: NodeJS.Platform; isNewFile: boolean; phase: string; attempt: number }) => string)
  | undefined
const Refusal = fileMod.AtomicWriteRefusal as (new (...a: never[]) => Error) | undefined
const { _resetFaultInjectionCountersForTests } = await import('../../src/substrate/durablePublish.ts')

const OLD = 'OLD BYTES — the previous contents\n'.repeat(120)
const NEW = 'NEW BYTES — the replacement\n'.repeat(200)
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(n => n.includes('.tmp.'))

function attempt(target: string, content: string): { threw: unknown } {
  try {
    write(target, content)
    return { threw: undefined }
  } catch (e) {
    return { threw: e }
  }
}
const isTypedRefusal = (e: unknown, code: string, target: string): boolean =>
  Refusal !== undefined &&
  e instanceof Refusal &&
  (e as { code?: string }).code === code &&
  e.message.includes(target) &&
  /previous contents/.test(e.message)

// ── §1 the pure classifier ──────────────────────────────────────────────────
section('§1 classifyAtomicWriteFailure — the fallback decision is a table')
{
  check('the classifier exists', typeof classify === 'function')
  if (typeof classify === 'function') {
    const posix = (code: string, isNewFile = false, phase = 'rename', attempt = 1) => classify(code, { platform: 'linux', isNewFile, phase, attempt })
    const win = (code: string, isNewFile = false, phase = 'rename', attempt = 1) => classify(code, { platform: 'win32', isNewFile, phase, attempt })
    for (const code of ['ENOSPC', 'EROFS', 'EIO', 'EDQUOT', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EXDEV']) {
      check(`${code} refuses on posix (a direct write would fail the same way after truncating)`, posix(code) === 'refuse', posix(code))
      check(`${code} refuses on win32`, win(code) === 'refuse', win(code))
    }
    check('win32 transient class (EBUSY) on the first attempt retries the atomic path with a fresh temp', win('EBUSY') === 'retry-atomic', win('EBUSY'))
    check('win32 transient class (EPERM) on the first attempt retries the atomic path', win('EPERM') === 'retry-atomic', win('EPERM'))
    check('win32 transient class past the fresh-temp budget at the rename refuses (the destination is held)', win('EBUSY', false, 'rename', 9) === 'refuse', win('EBUSY', false, 'rename', 9))
    check('win32 transient class past the budget at the temp write, existing file ⇒ the guarded direct write', win('EACCES', false, 'temp-write', 9) === 'direct-write', win('EACCES', false, 'temp-write', 9))
    check('posix EACCES at the temp write on an existing file ⇒ the guarded direct write (dir refuses a sibling, file may accept)', posix('EACCES', false, 'temp-write') === 'direct-write', posix('EACCES', false, 'temp-write'))
    check('posix EACCES at the temp write on a NEW file refuses (the directory refuses the file too)', posix('EACCES', true, 'temp-write') === 'refuse', posix('EACCES', true, 'temp-write'))
    check('posix EACCES at the rename refuses', posix('EACCES', false, 'rename') === 'refuse', posix('EACCES', false, 'rename'))
    check('an unclassified code on an existing file takes the guarded direct write (the old rescue, now safe)', posix('EWHATEVER') === 'direct-write', posix('EWHATEVER'))
    check('an unclassified code on a new file refuses', posix('EWHATEVER', true) === 'refuse', posix('EWHATEVER', true))
  }
}

// ── §2 injected structural failures at the rename ───────────────────────────
section('§2 ENOSPC · EROFS · EIO · EDQUOT at the rename — refused typed, old bytes intact')
for (const code of ['ENOSPC', 'EROFS', 'EIO', 'EDQUOT']) {
  const dir = join(scratch, `s2-${code.toLowerCase()}`)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'source.ts')
  writeFileSync(target, OLD)
  process.env.MERCURY_FAULT_INJECT = `rename@source.ts:${code.toLowerCase()}`
  _resetFaultInjectionCountersForTests()
  const { threw } = attempt(target, NEW)
  delete process.env.MERCURY_FAULT_INJECT
  check(`${code}: the write throws a typed AtomicWriteRefusal carrying the code and the file`, isTypedRefusal(threw, code, target), threw instanceof Error ? `${threw.name}: ${threw.message}` : String(threw))
  check(`${code}: the destination keeps its old bytes byte-for-byte`, readFileSync(target, 'utf8') === OLD, `size now ${statSync(target).size}`)
  check(`${code}: no temp residue`, tempsIn(dir).length === 0, tempsIn(dir).join(','))
}

// ── §3 injected ENOSPC at the temp write ────────────────────────────────────
section('§3 ENOSPC at the temp write — refused typed, old bytes intact')
{
  const dir = join(scratch, 's3')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'source.ts')
  writeFileSync(target, OLD)
  process.env.MERCURY_FAULT_INJECT = 'temp-write@source.ts:enospc'
  _resetFaultInjectionCountersForTests()
  const { threw } = attempt(target, NEW)
  delete process.env.MERCURY_FAULT_INJECT
  check('the write throws the typed refusal (ENOSPC)', isTypedRefusal(threw, 'ENOSPC', target), threw instanceof Error ? `${threw.name}: ${threw.message}` : 'no throw')
  check('the destination keeps its old bytes', readFileSync(target, 'utf8') === OLD, `size now ${statSync(target).size}`)
  check('no temp residue', tempsIn(dir).length === 0)
}

// ── §4 the guarded direct write ─────────────────────────────────────────────
section('§4 the guarded direct write — a directory that refuses a sibling')
if (process.platform === 'win32') {
  check('skipped by name: the POSIX directory-mode arm does not apply on win32', true)
} else if (process.getuid?.() === 0) {
  check('skipped by name: root ignores directory modes — the arm cannot fire', true)
} else {
  const dir = join(scratch, 's4')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'source.ts')
  writeFileSync(target, OLD)
  chmodSync(dir, 0o555)
  try {
    const plain = attempt(target, NEW)
    check('a writable file in a read-only directory still takes the new content (the rescue stays)', plain.threw === undefined && readFileSync(target, 'utf8') === NEW, plain.threw instanceof Error ? plain.threw.message : `size ${statSync(target).size}`)
    writeFileSync(target, OLD)
    process.env.MERCURY_FAULT_INJECT = 'direct-write@source.ts:enospc'
    _resetFaultInjectionCountersForTests()
    const failed = attempt(target, NEW)
    delete process.env.MERCURY_FAULT_INJECT
    check('a direct write that fails midway throws the typed refusal', isTypedRefusal(failed.threw, 'ENOSPC', target), failed.threw instanceof Error ? `${failed.threw.name}: ${failed.threw.message}` : 'no throw')
    check('…and the old bytes are RESTORED byte-for-byte', readFileSync(target, 'utf8') === OLD, `size now ${statSync(target).size}`)
  } finally {
    chmodSync(dir, 0o755)
  }
}

// ── §5 LIVE: a real out-of-space volume (macOS) ─────────────────────────────
section('§5 LIVE — a 1 MiB volume filled to ENOSPC (the audit\'s exact shape)')
if (process.platform !== 'darwin' || !existsSync('/usr/bin/hdiutil')) {
  check('skipped by name: the live volume arm needs macOS hdiutil (the injected arms above carry the law elsewhere)', true)
} else {
  const image = join(scratch, 'tiny.dmg')
  const mount = join(scratch, 'mnt')
  mkdirSync(mount, { recursive: true })
  const env = { ...process.env }
  const created = spawnSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '1m', '-fs', 'HFS+', '-volname', 'mtiny', image], { encoding: 'utf8', windowsHide: true, env })
  const attached = created.status === 0 && spawnSync('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mount, image], { encoding: 'utf8', windowsHide: true, env }).status === 0
  if (!attached) {
    check('skipped by name: the disk image could not be attached on this host', true, created.stderr)
  } else {
    try {
      const target = join(mount, 'source.ts')
      writeFileSync(target, OLD)
      // Fill the volume until the kernel refuses.
      let chunks = 0
      try {
        const fd = openSync(join(mount, 'filler.bin'), 'w')
        const chunk = Buffer.alloc(64 * 1024, 1)
        try {
          for (;;) {
            writeSync(fd, chunk)
            chunks++
          }
        } finally {
          closeSync(fd)
        }
      } catch (e) {
        check('the volume is full (the filler hit ENOSPC)', (e as { code?: string }).code === 'ENOSPC', `${(e as { code?: string }).code} after ${chunks} chunks`)
      }
      // The replacement must not fit in the tail the filler left (under one
      // 64 KiB chunk) even after the old blocks are freed — that is what
      // turned the truncating fallback into a zero-length file.
      const { threw } = attempt(target, NEW.repeat(64))
      check('LIVE: the write is refused typed with ENOSPC, naming the file', isTypedRefusal(threw, 'ENOSPC', target), threw instanceof Error ? `${threw.name}: ${threw.message}` : 'no throw')
      check('LIVE: the source file keeps its old bytes (never zero-length)', readFileSync(target, 'utf8') === OLD, `size now ${statSync(target).size}`)
      check('LIVE: no temp residue on the full volume', tempsIn(mount).length === 0, tempsIn(mount).join(','))
    } finally {
      spawnSync('/usr/bin/hdiutil', ['detach', '-quiet', '-force', mount], { encoding: 'utf8', windowsHide: true, env })
    }
  }
}

// ── §6 the writer keeps no truncating fallback ──────────────────────────────
section('§6 source pin — no truncating fallback remains in the writer')
{
  const src = readFileSync(join(import.meta.dir, '../../src/utils/file.ts'), 'utf8')
  const writer = src.slice(src.indexOf('function guardedDirectWriteSync'))
  check('the writer never opens the destination with the truncating writeFileSync', writer.length > 0 && !/writeFileSync\(target,/.test(writer))
  check('the guarded direct write opens the destination without truncation', /openSync\(target, 'r\+'\)/.test(writer))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-write-keeps-old-bytes${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
