#!/usr/bin/env bun
// ============================================================================
//  scripts/skills/prove-skill-discovery.ts — skills load from Mercury's homes
//  alone, and a skill body's template tokens expand in Mercury's spelling
//  alone.
//
//   §1 HOMES: a scratch project carries a skill under `.mercury/skills` and a
//      same-shaped twin under another product's `<other>/skills` folder; the
//      same twin pair sits in the scratch user home, and a legacy-command
//      pair sits under `commands`. The catalogue carries every Mercury twin
//      and never an other-folder twin. The watch-path list and the
//      mid-session discovery walk answer the same way.
//   §2 TOKENS: a body carrying `${MERCURY_SKILL_DIR}` / `${MERCURY_SESSION_ID}`
//      beside another product's token spellings renders with Mercury's
//      expanded and the others left literal.
//   §3 POISON CONTROLS: every predicate above is fed a poisoned input (the
//      other folder's skill present in the catalogue; the other token
//      expanded; the other folder in the walk) and FAILS on it — a check
//      that cannot fail is not a check. The twin control closes the loop:
//      the absent skills are byte-for-byte the shape of the ones that loaded,
//      so the folder is the only discriminator.
//
//  The other product's folder name and token stems are composed from parts
//  so this file never spells them. HOME and the config home are scratch and
//  set BEFORE any product import; no network; nothing left behind.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-proof' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const J = (...parts: string[]): string => parts.join('')
const OTHER_HOME = J('.cla', 'ude')
const OTHER_DIR_TOKEN = J('${CLA', 'UDE_SKILL_DIR}')
const OTHER_SESSION_TOKEN = J('${CLA', 'UDE_SESSION_ID}')
const MERCURY_DIR_TOKEN = '${MERCURY_SKILL_DIR}'
const MERCURY_SESSION_TOKEN = '${MERCURY_SESSION_ID}'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-skill-discovery-'))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const project = join(home, 'project')
mkdirSync(configHome, { recursive: true })
mkdirSync(project, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.HOME = home
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(project)

// ── the fixture ─────────────────────────────────────────────────────────────
const BODY = [
  `dir mercury=${MERCURY_DIR_TOKEN}`,
  `dir other=${OTHER_DIR_TOKEN}`,
  `session mercury=${MERCURY_SESSION_TOKEN}`,
  `session other=${OTHER_SESSION_TOKEN}`,
].join('\n')
function skill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: proof skill ${name}\n---\n${BODY}\n`)
}
function legacyCommand(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: proof command ${name}\n---\n${name}\n`)
}
// twins at project scope, user scope, the legacy form, and a subdirectory
// for the mid-session walk — Mercury home beside the other product's folder
skill(join(project, '.mercury', 'skills'), 'project-real')
skill(join(project, OTHER_HOME, 'skills'), 'project-other')
skill(join(configHome, 'skills'), 'user-real')
skill(join(home, OTHER_HOME, 'skills'), 'user-other')
legacyCommand(join(project, '.mercury', 'commands'), 'real-cmd')
legacyCommand(join(project, OTHER_HOME, 'commands'), 'other-cmd')
skill(join(project, 'sub', '.mercury', 'skills'), 'dyn-real')
skill(join(project, 'sub', OTHER_HOME, 'skills'), 'dyn-other')

const loader = await import('../../src/skills/loadSkillsDir.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(" skill discovery — Mercury's homes alone; Mercury's tokens alone")
console.log('============================================================')

// ── the predicates (each judged on the real result in §1/§2 and on a poisoned
//    input in §3) ─────────────────────────────────────────────────────────────
const MERCURY_NAMES = ['project-real', 'user-real', 'real-cmd']
const OTHER_NAMES = ['project-other', 'user-other', 'other-cmd']
const carriesMercuryOnly = (names: Set<string>): boolean =>
  MERCURY_NAMES.every(n => names.has(n)) && OTHER_NAMES.every(n => !names.has(n))
const expandsMercuryOnly = (text: string, dir: string, sessionId: string): boolean =>
  text.includes(`dir mercury=${dir}`) &&
  text.includes(`session mercury=${sessionId}`) &&
  text.includes(`dir other=${OTHER_DIR_TOKEN}`) &&
  text.includes(`session other=${OTHER_SESSION_TOKEN}`) &&
  !text.includes(MERCURY_DIR_TOKEN) &&
  !text.includes(MERCURY_SESSION_TOKEN)
const walksMercuryOnly = (dirs: string[]): boolean =>
  dirs.includes(join(project, 'sub', '.mercury', 'skills')) &&
  dirs.every(d => !d.includes(`${sep}${OTHER_HOME}${sep}`))

// ── §1 homes ────────────────────────────────────────────────────────────────
console.log("[1] the catalogue carries Mercury's homes and never the other product's folder")
const commands = await loader.getSkillDirCommands(project)
const names = new Set(commands.map(c => c.name))
check('the Mercury twins load: project, user, legacy command', MERCURY_NAMES.every(n => names.has(n)), [...names].join(', '))
for (const n of OTHER_NAMES) check(`the other product's folder is never read: ${n} absent`, !names.has(n))
check('the homes predicate holds on the real catalogue', carriesMercuryOnly(names), [...names].join(', '))
const watch = loader.getProjectSkillsWatchPaths('skills', project)
check('the watch list names the Mercury project home only', watch.length === 1 && watch[0] === join(project, '.mercury', 'skills'), watch.join(', '))
const walked = await loader.discoverSkillDirsForPaths([join('sub', 'deep', 'file.ts')], project)
check('the mid-session walk discovers the Mercury home only', walksMercuryOnly(walked), walked.join(', '))
await loader.addSkillDirectories(walked)
const dynamic = new Set(loader.getDynamicSkills().map(c => c.name))
check('the dynamic map carries the Mercury twin and never the other', dynamic.has('dyn-real') && !dynamic.has('dyn-other'), [...dynamic].join(', '))

// ── §2 tokens ───────────────────────────────────────────────────────────────
console.log("[2] a body expands Mercury's template tokens and leaves the other product's literal")
const real = commands.find(c => c.name === 'project-real')
let rendered = ''
if (real && real.type === 'prompt') {
  const blocks = await real.getPromptForCommand('', undefined as never)
  rendered = blocks.map(b => (b as { text?: string }).text ?? '').join('')
}
const realDir = join(project, '.mercury', 'skills', 'project-real')
const sessionId = String(getSessionId())
check('the skill rendered', rendered.length > 0)
check(`${MERCURY_DIR_TOKEN} expands to the skill directory`, rendered.includes(`dir mercury=${realDir}`), rendered.slice(0, 300))
check(`${MERCURY_SESSION_TOKEN} expands to the session id`, rendered.includes(`session mercury=${sessionId}`))
check("the other product's skill-dir token stays literal", rendered.includes(`dir other=${OTHER_DIR_TOKEN}`))
check("the other product's session token stays literal", rendered.includes(`session other=${OTHER_SESSION_TOKEN}`))
check('the token predicate holds on the real render', expandsMercuryOnly(rendered, realDir, sessionId))
const loaderSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'skills', 'loadSkillsDir.ts'), 'utf8')
check(
  "the loader's token regexes spell Mercury's stems alone",
  loaderSrc.includes('/\\$\\{MERCURY_SKILL_DIR\\}/g') &&
    loaderSrc.includes('/\\$\\{MERCURY_SESSION_ID\\}/g') &&
    !loaderSrc.includes(J('CLA', 'UDE_SKILL_DIR')) &&
    !loaderSrc.includes(J('CLA', 'UDE_SESSION_ID')),
)

// ── §3 poison controls ──────────────────────────────────────────────────────
console.log('[3] poison controls — each predicate fails on the compat it forbids')
check("a catalogue carrying the other folder's project skill FAILS the homes predicate", !carriesMercuryOnly(new Set([...names, 'project-other'])))
check("a catalogue carrying the other folder's user skill FAILS the homes predicate", !carriesMercuryOnly(new Set([...names, 'user-other'])))
check("a catalogue carrying the other folder's legacy command FAILS the homes predicate", !carriesMercuryOnly(new Set([...names, 'other-cmd'])))
check("a render that expanded the other product's skill-dir token FAILS the token predicate", !expandsMercuryOnly(rendered.replaceAll(OTHER_DIR_TOKEN, realDir), realDir, sessionId))
check("a render that expanded the other product's session token FAILS the token predicate", !expandsMercuryOnly(rendered.replaceAll(OTHER_SESSION_TOKEN, sessionId), realDir, sessionId))
check('a walk that discovered the other folder FAILS the walk predicate', !walksMercuryOnly([...walked, join(project, 'sub', OTHER_HOME, 'skills')]))
check(
  'twin control: every absent skill has a same-shaped Mercury twin that loaded',
  names.has('project-real') && names.has('user-real') && names.has('real-cmd') && dynamic.has('dyn-real'),
)

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ SKILL DISCOVERY — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
