#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-show-verb-honesty.ts — `mercury show` speaks user
//  errors as its own, with honest exits (FC-099). A non-image file rode the
//  renderer's link-degrade tier (built for missing terminals/bindings) and
//  exited 0 with a bare [link] line — a success for a user error.
//
//  Live on the built artifact (no credential, no model):
//    · a missing path refuses rc 1 naming the read failure;
//    · a NON-IMAGE file refuses rc 1 naming the signature test;
//    · a real PNG exits 0 with the protocol tag on stderr (the link tier is
//      an honest degrade for a protocol-less environment);
//    · the bare verb refuses rc 1 (the option table's own arity error).
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-show-verb-honesty.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
} else {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'show-verb-')))
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'show-fixtures-')))
  const run = (args: string[]): { status: number | null; err: string } => {
    const r = spawnSync('node', [DIST, 'show', ...args], {
      env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: undefined } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60000,
    })
    return { status: r.status, err: r.stderr ?? '' }
  }

  writeFileSync(join(dir, 'not-an-image.txt'), 'plain words')
  const crc = (buf: Buffer): Buffer => {
    let c = ~0 >>> 0
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
    const out = Buffer.alloc(4)
    out.writeUInt32BE(~c >>> 0)
    return out
  }
  const chunk = (kind: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const kb = Buffer.concat([Buffer.from(kind, 'latin1'), body])
    return Buffer.concat([len, kb, crc(kb)])
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(join(dir, 'tiny.png'), png)

  const missing = run([join(dir, 'absent.png')])
  check('a missing path refuses rc 1 naming the read failure', missing.status === 1 && /Cannot read|Failed to display/.test(missing.err), `rc=${missing.status} ${missing.err.slice(0, 80)}`)

  const notImage = run([join(dir, 'not-an-image.txt')])
  check(
    'a NON-IMAGE file refuses rc 1 naming the signature test (never a 0-exit link line)',
    notImage.status === 1 && notImage.err.includes('not an image file'),
    `rc=${notImage.status} ${notImage.err.slice(0, 80)}`,
  )

  const real = run([join(dir, 'tiny.png')])
  check(
    'a real PNG exits 0 with the protocol tag (the link tier is an honest protocol degrade)',
    real.status === 0 && /^\[[a-z]+\] /.test(real.err),
    `rc=${real.status} ${real.err.slice(0, 60)}`,
  )

  const bare = run([])
  check('the bare verb refuses rc 1', bare.status === 1 && bare.err.includes('missing required argument'), `rc=${bare.status}`)

  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-show-verb-honesty: all green' : `\nprove-show-verb-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
