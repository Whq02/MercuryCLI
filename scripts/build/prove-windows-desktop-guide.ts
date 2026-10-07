import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const guide = readFileSync(join(root, 'docs/INSTALL-WINDOWS-FROM-SOURCE.md'), 'utf8')
const build = readFileSync(join(root, 'build.ts'), 'utf8')
const command = 'bun run scripts/vendor/build-desktop.ts'
let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
const prepare = guide.slice(guide.indexOf('## 7.'), guide.indexOf('## 8.'))
check('the build names the desktop preparation command', build.includes(command))
check('Windows source preparation builds the desktop driver before bundling', prepare.includes(command))
check('the guide names the Computer tool and the cargo prerequisite beside the desktop step', /desktop driver[\s\S]*Computer tool[\s\S]*cargo/.test(prepare))
console.log(failures === 0 ? 'prove-windows-desktop-guide: ALL LAWS HOLD' : `prove-windows-desktop-guide: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
