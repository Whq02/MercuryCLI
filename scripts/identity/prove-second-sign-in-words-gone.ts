import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
const root = join(import.meta.dir, '../..')
const self = 'scripts/identity/prove-second-sign-in-words-gone.ts'
const everywhere = [
  'signInPockets',
  'signInRoster',
  'pocketInUse',
  'forgetPocket',
  'pocketEntries',
  'PocketEntry',
  'otherSignInsLine',
  'PROJECT_SIGN_IN_FILE',
  'familySignInRoster',
  'everySignInRoster',
  'useDefaultSignIn',
  'applyProjectSignInChoices',
  'bindProjectSignInChoicesToSettings',
  'projectSignInRefusal',
  'credentials.signIns',
  '/logins use',
  '/logins2',
  'sign-in pocket',
  'waits — /logins use',
]
const docsOnly = [/\bpockets?\b/i, /\bsecond sign-in\b/i, /\bsign-in slot\b/i]
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(tsx?|mjs|md|txt|json|sh)$/.test(entry.name) ? [join(dir, entry.name)] : [])
const read = (area: string) => walk(join(root, area)).map(path => [relative(root, path), readFileSync(path, 'utf8')] as const).filter(([rel]) => rel !== self)
const sources = [...read('src'), ...read('docs'), ...read('scripts'), ['README.md', readFileSync(join(root, 'README.md'), 'utf8')] as const]
const docs = sources.filter(([rel]) => rel.startsWith('docs/') || rel === 'README.md')
let failures = 0
const report = (label: string, hits: string[]) => {
  if (hits.length > 0) failures++
  console.log(`[${hits.length === 0 ? 'PASS' : 'FAIL'}] ${label}${hits.length ? ` — ${hits.join(', ')}` : ''}`)
}
for (const words of everywhere) report(`second-sign-in spelling absent from src, docs, scripts: ${JSON.stringify(words)}`, sources.filter(([, text]) => text.includes(words)).map(([rel]) => rel))
for (const re of docsOnly) report(`second-sign-in word absent from the docs: ${re.source}`, docs.filter(([, text]) => re.test(text)).map(([rel]) => rel))
console.log(`second-sign-in-words-gone: ${everywhere.length + docsOnly.length} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
