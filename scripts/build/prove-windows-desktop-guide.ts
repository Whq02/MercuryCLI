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
const byHand = guide.slice(guide.indexOf('## 6.'), guide.indexOf('## 8.'))
const setup = String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.setup)
const setupSteps = [...setup.matchAll(/scripts\/vendor\/([\w-]+)\.ts/g)].map(match => match[1]!)
const NO_WINDOWS_DOWNLOAD: Record<string, string> = { 'fetch-brush': 'build-brush' }
const unnamed = setupSteps.filter(step => !byHand.includes(`scripts/vendor/${NO_WINDOWS_DOWNLOAD[step] ?? step}.ts`))
const fetchBlock = /```powershell\n((?:bun run scripts\/vendor\/fetch-[\w-]+\.ts\n)+)```/.exec(prepare)?.[1] ?? ''
const fetched = fetchBlock.trim().split('\n').filter(Boolean).length
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
check('the build names the desktop preparation command', build.includes(command))
check('Windows source preparation builds the desktop driver before bundling', prepare.includes(command))
check('the guide names the Computer tool and the cargo prerequisite beside the desktop step', /desktop driver[\s\S]*Computer tool[\s\S]*cargo/.test(prepare))
check(`the setup command runs ${setupSteps.length} vendor steps and the by-hand road of steps 6 and 7 names every one (brush by its build, as no Windows binary is published)${unnamed.length ? `: missing ${unnamed.join(', ')}` : ''}`, setupSteps.length >= 13 && unnamed.length === 0)
check(`step 7 counts its own fetch commands: ${fetched} listed, the sentence says "these ${COUNT_WORDS[fetched]} commands"`, fetched > 0 && prepare.includes(`these ${COUNT_WORDS[fetched]} commands`))
check(`step 6 names the same count of fetched packs: "the ${COUNT_WORDS[fetched]} fetched packs in step 7"`, byHand.replace(/\s+/g, ' ').includes(`the ${COUNT_WORDS[fetched]} fetched packs in step 7`))
check('the page tells a builder how long the Rust-built packs take beside the downloads', /Time: about \d+ minutes[\s\S]{0,160}built with Rust[\s\S]{0,60}about \d+ more/.test(guide))
console.log(failures === 0 ? 'prove-windows-desktop-guide: ALL LAWS HOLD' : `prove-windows-desktop-guide: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
