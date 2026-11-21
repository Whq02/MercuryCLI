import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const guide = readFileSync(join(root, 'docs/INSTALL-WINDOWS-FROM-SOURCE.md'), 'utf8')
const build = readFileSync(join(root, 'build.ts'), 'utf8')
const command = 'bun run scripts/vendor/build-desktop.ts'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
}
const byHand = guide.slice(guide.indexOf('## 6.'), guide.indexOf('## 8.'))
const setup = String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.setup)
const setupSteps = [...setup.matchAll(/scripts\/vendor\/([\w-]+)\.ts/g)].map(match => match[1]!)
const NO_WINDOWS_DOWNLOAD: Record<string, string> = { 'fetch-brush': 'build-brush' }
const NOT_BUILT_ON_WINDOWS = new Set(['build-bash'])
const unnamed = setupSteps.filter(step => !NOT_BUILT_ON_WINDOWS.has(step) && !byHand.includes(`scripts/vendor/${NO_WINDOWS_DOWNLOAD[step] ?? step}.ts`))
check('the build names the desktop preparation command', build.includes(command), `build.ts must name the command ${command} (its desktop preparation message)`)
check(`the setup command runs ${setupSteps.length} vendor steps and the by-hand road of steps 6 and 7 names every one (brush by its build, as no Windows binary is published; the bash pack that is built is the macOS and Linux one, and the Windows one is fetched)${unnamed.length ? `: missing ${unnamed.join(', ')}` : ''}`, setupSteps.length >= 13 && unnamed.length === 0, `docs/INSTALL-WINDOWS-FROM-SOURCE.md steps 6 and 7 must name scripts/vendor/<step>.ts for every vendor step in the setup script of package.json${unnamed.length ? ` (missing ${unnamed.join(', ')})` : `; found only ${setupSteps.length} steps, expected at least 13, so check the setup script in package.json`}`)
console.log(failures === 0 ? 'prove-windows-desktop-guide: ALL LAWS HOLD' : `prove-windows-desktop-guide: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
