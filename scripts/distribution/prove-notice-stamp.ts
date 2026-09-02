#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  composeNoticeStamp,
  CURRENT_NOTICE_SLOTS,
  hasCurrentNoticeStamp,
  stampNoticeOnSource,
} from '../../src/constants/legalNotice.js'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const ROOT = join(import.meta.dir, '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

console.log('notice stamp — composition law + dist gate + NOTICE preservation sweep')

{
  const empty = composeNoticeStamp('1.0.0', { copyrightLine: null, licensePointer: null })
  check('null slots ⇒ their lines are ABSENT (no placeholder text ever)', !empty.includes('null') && empty.split('\n').length === 6)
  check('the stamp always names the product + version', empty.includes('Mercury 1.0.0 — NOTICE'))
  check('the stamp always carries the third-party attribution pointer', empty.includes('NOTICES.md') && empty.includes('THIRD_PARTY_NOTICES.md'))
  check('the stamp is deterministic (no dates — reproducible-build safe)', !/\d{4}-\d{2}-\d{2}/.test(empty))

  const filled = composeNoticeStamp('1.0.0', { copyrightLine: 'COPYRIGHT-SLOT-TEXT', licensePointer: 'LICENSE-SLOT-TEXT' })
  check('filled slots render verbatim', filled.includes('// COPYRIGHT-SLOT-TEXT') && filled.includes('// LICENSE-SLOT-TEXT'))
  check('every stamp line is a JS line comment (artifact-safe)', filled.split('\n').filter(l => l.length > 0).every(l => l.startsWith('// ')))

  const plain = stampNoticeOnSource('const x = 1\n', '1.0.0')
  check('stamping prepends on shebang-less source', plain.startsWith(composeNoticeStamp('1.0.0')) && plain.endsWith('const x = 1\n'))
  const shebanged = stampNoticeOnSource('#!/usr/bin/env node\nconst x = 1\n', '1.0.0')
  check('a #! first line stays byte 0 (OS loader law); the stamp follows it', shebanged.startsWith('#!/usr/bin/env node\n' + composeNoticeStamp('1.0.0')))
  check('has-current accepts both placements', hasCurrentNoticeStamp(plain, '1.0.0') && hasCurrentNoticeStamp(shebanged, '1.0.0'))
  check('has-current refuses a missing stamp', !hasCurrentNoticeStamp('const x = 1\n', '1.0.0'))
  check('has-current refuses a STALE stamp (different version)', !hasCurrentNoticeStamp(plain, '2.0.0'))
  check(
    'has-current refuses a stale SLOT state (a slot edit forces restamping)',
    !hasCurrentNoticeStamp(plain, '1.0.0', { copyrightLine: 'NEWLY-DRAFTED', licensePointer: null }),
  )
}

for (const artifact of ['mercury.mjs', 'verify-artifact.mjs']) {
  const path = join(ROOT, 'dist', artifact)
  if (!existsSync(path)) {
    console.log(`  · dist/${artifact} stamp check SKIPPED (not built on this checkout — build.ts self-checks the stamp on every build)`)
    continue
  }
  const head = readFileSync(path, 'utf8').slice(0, 4096)
  check(`dist/${artifact} carries the CURRENT stamp (version ${VERSION}, live slots)`, hasCurrentNoticeStamp(head, VERSION))
}

{
  const found: Array<{ pkg: string; file: string }> = []
  const NOTICE_RE = /^NOTICE(\.(txt|md))?$/i
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('package.json')) {
      for (const e of entries) {
        try {
          if (NOTICE_RE.test(e) && statSync(join(dir, e)).isFile()) {
            const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
            found.push({ pkg: meta.name ?? dir, file: e })
          }
        } catch {
        }
      }
    }
    for (const e of entries) {
      if (e === '.bin' || e === '.cache') continue
      const full = join(dir, e)
      try {
        if (statSync(full).isDirectory()) walk(full)
      } catch {
      }
    }
  }
  walk(join(ROOT, 'node_modules'))

  const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  check('THIRD_PARTY_NOTICES.md carries the preservation section', notices.includes('## Preserved NOTICE files (Apache-2.0 §4(d))'))
  if (found.length === 0) {
    check('sweep found no NOTICE files and the inventory states exactly that', notices.includes('found **none** in the current dependency set'))
  } else {
    check(`sweep found ${found.length} NOTICE file(s) and the inventory must NOT claim none`, !notices.includes('found **none**'))
    for (const f of found) {
      check(`NOTICE preserved for ${f.pkg}`, notices.includes(`### ${f.pkg} `), 'regenerate: bun run scripts/distribution/generate-third-party-notices.ts')
    }
  }
  if (CURRENT_NOTICE_SLOTS.copyrightLine) {
    check('filled copyright slot present at the inventory head', notices.includes(CURRENT_NOTICE_SLOTS.copyrightLine))
  }
  if (CURRENT_NOTICE_SLOTS.licensePointer) {
    check('filled licence-pointer slot present at the inventory head', notices.includes(CURRENT_NOTICE_SLOTS.licensePointer))
  }
}

{
  const build = readFileSync(join(ROOT, 'build.ts'), 'utf8')
  check('build.ts stamps both artifacts and self-checks the stamp', build.includes('stampNoticeOnSource') && build.includes('hasCurrentNoticeStamp') && build.includes('does not carry the current NOTICE stamp'))
}

if (failures > 0) {
  console.error(`\nprove-notice-stamp: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-notice-stamp: all green')
