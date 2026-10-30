#!/usr/bin/env bun
// gate-watch: README.md docs/** package.json build.ts assets/splash/** scripts/ops/** scripts/vendor/**
// gate-watch: src/main.tsx src/cli/** src/commands/** src/tools/** src/skills/bundled/** src/keybindings/**
// gate-watch: src/utils/settings/** src/utils/hooks/contract.ts src/substrate/flagRegistry.ts src/components/ConsoleOAuthFlow.tsx
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const argv = process.argv.slice(2)
const REPORT = argv.includes('--report')
const revAt = argv.indexOf('--rev')
const REV = revAt >= 0 ? argv[revAt + 1] ?? null : null
const fileAt = argv.indexOf('--file')
const ONLY_FILE = fileAt >= 0 ? argv[fileAt + 1] ?? null : null

if (!existsSync(join(ROOT, 'dist', 'mercury.mjs'))) {
  console.error('  [FAIL] dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}
const HOME = mkdtempSync(join(tmpdir(), 'docs-names-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

interface Hit {
  file: string
  line: number
  kind: string
  name: string
  detail: string
}

interface Unit {
  kind: 'span' | 'fence'
  line: number
  text: string
}

interface Vocab {
  rootVerbs: Set<string>
  verbSubs: Map<string, Set<string>>
  verbFlags: Map<string, Set<string>>
  cliFlags: Set<string>
  fastFlags: Set<string>
  toolingFlags: Set<string>
  slash: Set<string>
  skills: Set<string>
  loginWord: (word: string) => boolean
  tools: Set<string>
  ruleTools: Set<string>
  settingsPaths: string[][]
  settingsTop: Set<string>
  enums: Map<string, string[]>
  hookEvents: Set<string>
  envCorpus: Set<string>
  chords: string[]
  srcChords: Set<string>
  pathSegments: Set<string>
  repoPathExists: (path: string) => boolean
  packageScripts: Set<string>
  providerCount: number
  providerNames: string[]
  productText: string
  glyphLiterals: Map<string, string>
}

const EXTERNAL_FLAGS = new Map<string, string>([
  ['--rm', 'a container run'],
  ['--user', 'a container run and systemd'],
  ['--id', 'winget'],
  ['--frozen-lockfile', 'bun install'],
  ['--cached', 'git rm'],
  ['--get', 'git config'],
  ['--exact', 'cargo test'],
  ['--python-expr', 'the Blender command line'],
  ['--save-as', 'the Aseprite command line'],
  ['--spec-type', 'llama-server'],
  ['--mmproj', 'llama-server'],
  ['--enable-auto-tool-choice', 'vLLM'],
  ['--tool-call-parser', 'vLLM and SGLang'],
  ['--reasoning-parser', 'vLLM and SGLang'],
  ['--embd-dir', 'the image runtime'],
  ['--hires-upscalers-dir', 'the image runtime'],
  ['--sampling-method', 'the image runtime'],
  ['--scheduler', 'the image runtime'],
  ['--upscale-model', 'the image runtime'],
  ['--headless', 'the Godot binary'],
  ['--script', 'the Godot binary'],
  ['--check-only', 'the Godot binary'],
  ['--quit-after', 'the Godot binary'],
  ['--remote-debug', 'the Godot binary'],
  ['--warship-checks', 'an example suite argument in a Godot suites file'],
])

const SLASH_NOT_COMMANDS = new Map<string, string>([
  ['bin', 'a system directory'],
  ['etc', 'a system directory'],
  ['home', 'a system directory'],
  ['root', 'a system directory'],
  ['sbin', 'a system directory'],
  ['usr', 'a system directory'],
  ['var', 'a system directory'],
  ['embedded-form', 'a URL substring in a frame example'],
  ['hr', 'a price unit'],
  ['mercury-model-bank', 'a bank folder name'],
  ['models', 'a server route'],
  ['props', 'a server route'],
  ['v1', 'a server route'],
  ['name', 'a placeholder'],
  ['s', 'a Windows command switch'],
  ['work', 'a container mount'],
  ['workspace', 'a container mount'],
])

const ENV_NOT_NAMES = new Map<string, string>([
  ['COORDINATOR_ID', 'a placeholder in an example command'],
  ['SESSION_ID', 'a placeholder in an example command'],
])

const SETTINGS_LOOKALIKES = new Map<string, string>([
  ['VULCAN-GODOT-TOOLS.md:media.', 'fields of a Godot capture result'],
])

const REPO_PATHS_NOT_IN_TREE = new Map<string, string>([
  ['vendor/model', 'fetched by setup'],
  ['vendor/node/bin/node', 'fetched by setup'],
  ['assets/boat.png', 'a file in the reader\'s own project'],
  ['src/a.gd', 'a file in the reader\'s own project'],
  ['src/b.gd', 'a file in the reader\'s own project'],
  ['src/player/shield.gd', 'a file in the reader\'s own project'],
])

const PATH_SEGMENTS_NOT_IN_CODE = new Map<string, string>([
  ['review-tools', 'an example extension folder'],
  ['fold_tour', 'an example scratch folder'],
])

const LABELS_NOT_IN_CODE = new Map<string, string>([
  ['HTTP 5xx', 'a status class'],
  ['Opus 5.5 · failover', 'a model name beside the failover mark'],
  ['Aseprite 1.3.7-arm64', 'a version string the Aseprite program prints'],
  ['Aseprite 1.x-dev', 'a version string the Aseprite program prints'],
  ['Continued after 1 stream cut · context sent again', 'a line the chat composes around the count of cuts'],
  ['Mercury · memory', 'a popup title the settings popup composes from its view name'],
  ['CSI P', 'a terminal escape sequence'],
  ['ESC ESC', 'a terminal key sequence'],
])

const CHORDS_NOT_BOUND = new Map<string, string>([
  ['cmd+a', 'a keystroke the Computer tool sends to the target application'],
  ['cmd+shift+s', 'a keystroke the Computer tool sends to the target application'],
  ['ctrl+a', 'a keystroke the Computer tool sends to the target application, or the terminal protocol example'],
  ['ctrl+z', 'the shell job-control key'],
  ['alt+arrow', 'a terminal-profile example'],
  ['shift+;', 'a terminal-profile example'],
  ['shift+a', 'a terminal-profile example'],
])

function git(args: string[]): string {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function docPaths(): string[] {
  if (ONLY_FILE !== null) return [ONLY_FILE]
  if (REV !== null) {
    return git(['ls-tree', '-r', '--name-only', REV, '--', 'README.md', 'docs'])
      .split('\n')
      .filter(p => p === 'README.md' || /^docs\/[^/]+\.md$/.test(p) || /^docs\/templates\/[^/]+\.md$/.test(p) || p === 'docs/releases/README.md' || /^docs\/translations\/README\.[^/]+\.md$/.test(p))
      .sort()
  }
  const out = ['README.md']
  const list = (dir: string, re: RegExp): void => {
    for (const name of readdirSync(join(ROOT, dir)).sort()) if (re.test(name)) out.push(posix.join(dir, name))
  }
  list('docs', /\.md$/)
  list('docs/templates', /\.md$/)
  out.push('docs/releases/README.md')
  list('docs/translations', /^README\..+\.md$/)
  return out
}

function readDoc(path: string): string {
  if (ONLY_FILE !== null) return readFileSync(path, 'utf8')
  return REV !== null ? git(['show', `${REV}:${path}`]) : readFileSync(join(ROOT, path), 'utf8')
}

function codeUnits(text: string): Unit[] {
  const units: Unit[] = []
  const lines = text.split('\n')
  let fenced = false
  let start = 0
  let buf: string[] = []
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (fenced) {
        units.push({ kind: 'fence', line: start + 1, text: buf.join('\n') })
        buf = []
        fenced = false
      } else {
        fenced = true
        start = i + 1
      }
      return
    }
    if (fenced) {
      buf.push(raw)
      return
    }
    for (const m of raw.matchAll(/``([^`]+)``|`([^`]+)`/g)) units.push({ kind: 'span', line: i + 1, text: m[1] ?? m[2] ?? '' })
  })
  return units
}

function proseLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  let fenced = false
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      return
    }
    if (!fenced) out.push({ line: i + 1, text: raw })
  })
  return out
}

function textLines(text: string): Array<{ line: number; text: string }> {
  return text.split('\n').map((raw, i) => ({ line: i + 1, text: raw }))
}

const FLAG_RE = /(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g
const MERCURY_LINE_RE = /(?:^|[\s(`$])(?:mercury|node dist\/mercury\.mjs)\s+(.*)$/

function longFlagsOf(text: string): string[] {
  return [...text.matchAll(FLAG_RE)].map(m => m[0])
}

function wildcardMatch(paths: string[][], segs: string[]): boolean {
  return paths.some(p => p.length === segs.length && p.every((s, i) => s === '*' || segs[i] === '*' || s === segs[i]))
}

const MODS = '(?:ctrl|alt|shift|cmd|meta|opt|option|super)'
const CHORD_RE = new RegExp(`(?<![\\w+])(${MODS}(?:\\+${MODS})*\\+(?:←|→|↑|↓|[a-z0-9]+|[;,.'\\[\\]/\\\\=-]))(?![\\w])`, 'gi')
const TYPOGRAPHY = /[’‘“”…]/
const plainTypography = (s: string): string => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
const ARROWS: Record<string, string> = { '←': 'left', '→': 'right', '↑': 'up', '↓': 'down', option: 'alt', opt: 'alt' }

function normaliseChord(raw: string): string {
  return raw
    .toLowerCase()
    .split('+')
    .map(part => ARROWS[part] ?? part)
    .join('+')
}

const PATH_ROOT_RE = /(?:~\/\.mercury|<config home>|<config-home>|\$MERCURY_CONFIG_DIR|<project>\/\.mercury|(?<![\w.])\.mercury)((?:\/[A-Za-z0-9_.<>*{},@-]+)+)/g
const TOOL_WORD_RE = /`([A-Z][A-Za-z]+)`\s+(?:tool|verb)\b|\btool\s+`([A-Z][A-Za-z]+)`|\bthe\s+`([A-Z][A-Za-z]+)`\s+(?:tool|verb)\b/g
const RULE_FORM_RE = /`([A-Z][A-Za-z]+)\(([^`]*)\)`/g
const SKILL_WORD_RE = /`([a-z][a-z0-9:-]*)`\s+skills?\b|\bskills?\s+`([a-z][a-z0-9:-]*)`/g
const REPO_ROOTS = '(?:src|scripts|docs|native|vendor|sdk|sdk-py|integrations|fixtures|assets|bench|design-system|mercury-skills|receipts|\\.github|\\.githooks)'
const REPO_PATH_RE = new RegExp(`(?<![\\w@./-])(${REPO_ROOTS}\\/[A-Za-z0-9_./@-]*[A-Za-z0-9_])`, 'g')
const LINK_RE = /\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g
const ENV_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
const HOOK_PREFIXES = new Set(['turn', 'tool', 'permission', 'crewmate', 'compaction', 'session', 'file'])

function checkDoc(file: string, text: string, v: Vocab): Hit[] {
  const hits: Hit[] = []
  const add = (line: number, kind: string, name: string, detail: string): void => {
    hits.push({ file, line, kind, name, detail })
  }
  const units = codeUnits(text)
  const base = file.split('/').pop() ?? file
  const isTranslation = file.startsWith('docs/translations/')

  for (const { line, text: l } of textLines(text)) {
    for (const flag of longFlagsOf(l)) {
      if (v.cliFlags.has(flag) || v.fastFlags.has(flag) || v.toolingFlags.has(flag) || EXTERNAL_FLAGS.has(flag)) continue
      add(line, 'flag', flag, 'no verb of the command line, no fast-path usage and no tooling script carries this flag')
    }
    for (const m of l.matchAll(ENV_RE)) {
      const name = m[0]
      const after = l[(m.index ?? 0) + name.length] ?? ''
      if (after === '.' && /^\.[a-z]{2,4}\b/.test(l.slice((m.index ?? 0) + name.length))) continue
      if (ENV_NOT_NAMES.has(name) || v.envCorpus.has(name)) continue
      add(line, 'env', name, 'no source file carries this name')
    }
  }

  for (const u of units) {
    for (const row of u.text.split('\n')) {
      const m = row.match(MERCURY_LINE_RE)
      if (!m) continue
      const toks = (m[1] ?? '').split(/\s+/)
      let verb: string | null = null
      let sub: string | null = null
      const before: string[] = []
      const after: string[] = []
      for (const tk of toks) {
        if (/^--[a-z]/.test(tk)) {
          const flag = tk.replace(/^(--[a-z0-9-]+).*$/, '$1')
          ;(verb === null ? before : after).push(flag)
        } else if (verb === null && /^[a-z][a-z0-9-]*$/.test(tk) && v.rootVerbs.has(tk)) {
          verb = tk
        } else if (verb !== null && sub === null && /^[a-z][a-z0-9-]*$/.test(tk)) {
          sub = tk
        }
      }
      const first = toks.find(tk => !/^--?[a-zA-Z]/.test(tk) && tk !== '--')
      if (verb === null && first !== undefined && /^[a-z][a-z0-9-]*$/.test(first) && !v.rootVerbs.has(first) && first !== 'mercury') {
        add(u.line, 'verb', first, 'not a verb of the command line')
      }
      for (const flag of before) {
        if (!v.verbFlags.get('')!.has(flag) && !v.fastFlags.has(flag)) add(u.line, 'verb-flag', flag, 'not a flag of the bare command')
      }
      if (verb !== null) {
        const subs = v.verbSubs.get(verb)
        if (sub !== null && subs !== undefined && subs.size > 0 && !subs.has(sub) && !['run', 'status', 'stop', 'restart'].includes(sub)) {
          add(u.line, 'verb-sub', `${verb} ${sub}`, `not a subcommand of ${verb}`)
        }
        const key = sub !== null && v.verbFlags.has(`${verb} ${sub}`) ? `${verb} ${sub}` : verb
        const allowed = v.verbFlags.get(key)
        const verbAll = v.verbFlags.get(verb)
        if (allowed !== undefined && !['host', 'godot', 'daemon', 'acp', 'bridge'].includes(verb)) {
          for (const flag of after) {
            if (flag === '--help') continue
            if (!allowed.has(flag) && !(verbAll?.has(flag) ?? false)) add(u.line, 'verb-flag', `${verb} ${flag}`, `${flag} is not a flag of ${key}`)
          }
        }
      }
    }
  }

  const slashScan = [...proseLines(text)]
  for (const { line, text: l } of slashScan) {
    for (const m of l.matchAll(/(?<![\w/.~$:<>-])\/([a-z][a-z0-9-]*)(?![\w/.:@\\-])/g)) {
      const word = m[1] ?? ''
      if (v.slash.has(word) || v.skills.has(word) || SLASH_NOT_COMMANDS.has(word)) continue
      add(line, 'slash', `/${word}`, 'not a slash command, alias or bundled skill')
    }
  }
  for (const u of units) {
    if (u.kind !== 'span') continue
    const logins = u.text.match(/^\/logins\s+([a-z][a-z0-9.-]*)$/)
    if (logins !== null && !v.loginWord(logins[1] ?? '') && (logins[1] ?? '') !== 'compat') {
      add(u.line, 'logins-family', logins[1] ?? '', 'not a word /logins takes')
    }
  }

  const settingsHeads = v.settingsTop
  for (const u of units) {
    for (const m of u.text.matchAll(/(?<![\w./$-])([a-z][A-Za-z]*(?:\.(?:[A-Za-z_*]+|<[a-z -]+>))+)(?![\w(])/g)) {
      const raw = m[1] ?? ''
      const segs = raw.split('.').map(s => (/^<.*>$/.test(s) ? '*' : s))
      if (HOOK_PREFIXES.has(segs[0] ?? '') && segs.length === 2) {
        if (!v.hookEvents.has(raw) && !raw.endsWith('.*') && base === 'HOOKS.md') add(u.line, 'hook-event', raw, 'not a hook event')
        continue
      }
      if (!settingsHeads.has(segs[0] ?? '')) continue
      if (SETTINGS_LOOKALIKES.has(`${base}:${segs[0]}.`)) continue
      if (!wildcardMatch(v.settingsPaths, segs)) add(u.line, 'settings-key', raw, 'not a key of the settings schema')
    }
  }
  for (const u of units) {
    if (u.kind !== 'fence') continue
    let obj: unknown = null
    try {
      obj = JSON.parse(u.text)
    } catch {
      continue
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
    if (!Object.keys(obj as Record<string, unknown>).some(k => settingsHeads.has(k))) continue
    const walk = (o: Record<string, unknown>, prefix: string[]): void => {
      for (const [k, val] of Object.entries(o)) {
        const segs = [...prefix, k]
        if (!wildcardMatch(v.settingsPaths, segs)) {
          add(u.line, 'settings-key', segs.join('.'), 'not a key of the settings schema')
          continue
        }
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) walk(val as Record<string, unknown>, segs)
      }
    }
    walk(obj as Record<string, unknown>, [])
  }

  if (base === 'SETTINGS.md') {
    const lines = text.split('\n')
    let prefix = ''
    lines.forEach((raw, i) => {
      if (!raw.startsWith('|')) {
        prefix = ''
        return
      }
      const cells = raw.split('|').slice(1, -1).map(c => c.trim())
      const underModels = cells[0]?.match(/^Key under `([^`]+)`$/)
      if (underModels !== null && underModels !== undefined) {
        prefix = (underModels[1] ?? '').replace(/<[^>]+>/g, '*')
        return
      }
      const key = cells[0]?.match(/^`([^`]+)`$/)?.[1]
      if (key === undefined) return
      const path = (prefix !== '' && !key.includes('.') ? `${prefix}.${key}` : key).replace(/<[^>]+>/g, '*')
      const values = v.enums.get(path)
      if (values === undefined) return
      const named = new Set([...(cells[1] ?? '').matchAll(/`([A-Za-z][A-Za-z0-9-]*)`/g)].map(m => m[1]))
      for (const value of values) {
        if (value !== '' && !named.has(value)) add(i + 1, 'enum', `${path}: ${value}`, 'the row lists the choices of this key and leaves this one out')
      }
    })
  }

  for (const { line, text: l } of textLines(text)) {
    for (const m of l.matchAll(CHORD_RE)) {
      const chord = normaliseChord(m[1] ?? '')
      if (CHORDS_NOT_BOUND.has(chord)) continue
      const bound = v.chords.some(b => b === chord || b.startsWith(`${chord} `) || b.split(' ').includes(chord))
      if (!bound && !v.srcChords.has(chord)) add(line, 'chord', chord, 'no default binding and no source string carries this chord')
    }
  }

  if (!isTranslation) {
    for (const u of units) {
      if (u.kind !== 'span') continue
      const label = u.text.trim()
      if (!/^[A-Z][A-Za-z0-9&·'’.-]*(?: [A-Za-z0-9&·'’.-]+){1,8}$/.test(label) || label.length > 60) continue
      if (LABELS_NOT_IN_CODE.has(label) || v.productText.includes(label)) continue
      add(u.line, 'label', label, 'no screen, command or message of the product spells this label')
    }
  }

  if (!isTranslation) {
    for (const [plain, typed] of v.glyphLiterals) {
      let from = 0
      for (;;) {
        const at = text.indexOf(plain, from)
        if (at < 0) break
        from = at + plain.length
        add(text.slice(0, at).split('\n').length, 'glyph', plain, `the product spells it ${typed}`)
      }
    }
  }

  const toolNames = new Set([...v.tools, ...v.ruleTools])
  for (const { line, text: l } of textLines(text)) {
    for (const m of l.matchAll(TOOL_WORD_RE)) {
      const name = m[1] ?? m[2] ?? m[3] ?? ''
      if (!toolNames.has(name)) add(line, 'tool', name, 'not a tool of the roster')
    }
    for (const m of l.matchAll(RULE_FORM_RE)) {
      const name = m[1] ?? ''
      if (name === 'Tool') continue
      if (!toolNames.has(name)) add(line, 'tool', name, 'not a tool of the roster')
    }
    for (const m of l.matchAll(SKILL_WORD_RE)) {
      const name = m[1] ?? m[2] ?? ''
      if (!v.skills.has(name)) add(line, 'skill', name, 'not a bundled skill')
    }
  }
  if (isTranslation) {
    for (const u of units) {
      if (u.kind !== 'span') continue
      const m = u.text.trim().match(/^([A-Z][a-z]+(?:[A-Z][a-z]+)*)(?:\(.*\))?$/)
      if (m === null) continue
      const name = m[1] ?? ''
      if (!toolNames.has(name) && ![['Docker', 'file'].join(''), 'Enter', 'Esc', 'PATH', 'Tune'].includes(name)) add(u.line, 'tool', name, 'not a tool of the roster')
    }
  }

  for (const { line, text: l } of textLines(text)) {
    for (const m of l.matchAll(PATH_ROOT_RE)) {
      const segs = (m[1] ?? '').split('/').filter(Boolean)
      for (const seg of segs) {
        if (/[<>*{}]/.test(seg) || PATH_SEGMENTS_NOT_IN_CODE.has(seg)) continue
        if (!v.pathSegments.has(seg) && !v.pathSegments.has(seg.replace(/\.[a-z]+$/, ''))) {
          add(line, 'path', `${m[0]}`, `no source file spells the folder or file name ${seg}`)
          break
        }
      }
    }
    for (const m of l.matchAll(REPO_PATH_RE)) {
      const p = m[1] ?? ''
      if (/[<>*{}]/.test(p) || REPO_PATHS_NOT_IN_TREE.has(p)) continue
      if (!v.repoPathExists(p)) add(line, 'repo-path', p, 'no such file or folder in the tree')
    }
    for (const m of l.matchAll(LINK_RE)) {
      const target = posix.normalize(posix.join(posix.dirname(file), m[1] ?? ''))
      if (!v.repoPathExists(target)) add(line, 'repo-path', target, 'a link to nothing')
    }
    for (const m of l.matchAll(/\bbun run ([A-Za-z0-9:_./-]+)/g)) {
      const name = m[1] ?? ''
      if (/[\\/]|\.ts$/.test(name)) {
        if (!/[<>*{}]/.test(name) && !v.repoPathExists(name) && !REPO_PATHS_NOT_IN_TREE.has(name)) add(line, 'repo-path', name, 'no such script file in the tree')
      } else if (!v.packageScripts.has(name)) add(line, 'package-script', name, 'not a script of package.json')
    }
  }

  if (isTranslation) {
    const lead = text.split('\n').find(l => l.startsWith('- **') && l.includes('/llmhost') && l.includes('/localsetup'))
    const leadAt = lead === undefined ? 0 : text.split('\n').indexOf(lead) + 1
    for (const { line, text: l } of textLines(text)) {
      if (!l.includes('OpenCode Zen')) continue
      for (const m of l.matchAll(/(?<![\w.])(\d{2})(?![\w.])/g)) {
        if (Number(m[1]) < 15 || Number(m[1]) > 40) continue
        if (Number(m[1]) !== v.providerCount) add(line, 'count', m[1] ?? '', `the code has ${v.providerCount} provider families`)
      }
    }
    if (lead === undefined) add(1, 'count', 'provider list', 'no bullet names the provider list')
    else {
      for (const name of v.providerNames) {
        if (!lead.includes(name)) add(leadAt, 'provider-name', name, 'the README lists this provider and the translation\'s list leaves it out')
      }
    }
  }
  if (base === 'README.md' && file === 'README.md') {
    for (const { line, text: l } of textLines(text)) {
      for (const m of l.matchAll(/\b(\d+)\s+(?:model providers|providers)\b/g)) {
        if (Number(m[1]) !== v.providerCount) add(line, 'count', m[1] ?? '', `the code has ${v.providerCount} provider families`)
      }
    }
  }
  if (base === 'ENGINES.md') {
    for (const { line, text: l } of textLines(text)) {
      for (const m of l.matchAll(/\b(\d+)\s+sign-in provider families\b/g)) {
        if (Number(m[1]) !== v.providerCount) add(line, 'count', m[1] ?? '', `the code has ${v.providerCount} provider families`)
      }
    }
  }
  return hits
}

function parseHelp(txt: string): { opts: string[]; cmds: string[] } {
  let sec: 'o' | 'c' | null = null
  const opts: string[] = []
  const cmds: string[] = []
  for (const l of txt.split('\n')) {
    if (/^Options:/.test(l)) {
      sec = 'o'
      continue
    }
    if (/^Commands:/.test(l)) {
      sec = 'c'
      continue
    }
    if (/^\S/.test(l)) {
      sec = null
      continue
    }
    if (/^\s{10,}/.test(l)) continue
    const m = l.match(/^ {2}(\S.*?)(?:\s{2,}|$)/)
    if (!m) continue
    if (sec === 'o') opts.push(m[1] ?? '')
    if (sec === 'c') cmds.push(m[1] ?? '')
  }
  return { opts, cmds }
}

function helpOf(args: string[]): Promise<string> {
  return new Promise(resolve => {
    const child = spawn('node', [join(ROOT, 'dist', 'mercury.mjs'), ...args, '--help'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', d => (out += String(d)))
    const timer = setTimeout(() => child.kill(), 90_000)
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

async function pooled<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const at = next++
        if (at >= items.length) return
        out[at] = await fn(items[at]!)
      }
    }),
  )
  return out
}

function walkFiles(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue
      walkFiles(p, keep, out)
    } else if (st.isFile() && keep(p)) out.push(p)
  }
  return out
}

async function buildVocab(): Promise<Vocab> {
  const rootHelp = parseHelp(await helpOf([]))
  const verbNames = rootHelp.cmds.map(c => (c.split(/\s+/)[0] ?? '').split('|')).filter(n => n[0] !== 'help')
  const rootVerbs = new Set([...verbNames.flat(), 'help'])
  if (!rootVerbs.has('run') || !rootVerbs.has('health')) {
    console.error('  [FAIL] the root help of dist/mercury.mjs lists no run or health verb — the command line could not be read')
    process.exit(1)
  }
  const verbFlags = new Map<string, Set<string>>()
  const verbSubs = new Map<string, Set<string>>()
  const flagsOfOpts = (opts: string[]): Set<string> => new Set(opts.flatMap(s => [...s.matchAll(/--[a-z0-9-]+/g)].map(m => m[0])))
  verbFlags.set('', flagsOfOpts(rootHelp.opts))
  const rootCmdKey = JSON.stringify(rootHelp.cmds)
  const first = await pooled(verbNames, 6, async names => ({ name: names[0]!, help: parseHelp(await helpOf([names[0]!])) }))
  const second: Array<{ key: string; verb: string; sub: string; parentCmds: string }> = []
  for (const { name, help } of first) {
    if (JSON.stringify(help.cmds) === rootCmdKey) {
      verbFlags.set(name, new Set())
      continue
    }
    verbFlags.set(name, flagsOfOpts(help.opts))
    const subNames = help.cmds.map(c => (c.split(/\s+/)[0] ?? '').split('|')[0] ?? '').filter(n => n !== 'help')
    verbSubs.set(name, new Set(help.cmds.flatMap(c => (c.split(/\s+/)[0] ?? '').split('|'))))
    for (const sub of subNames) second.push({ key: `${name} ${sub}`, verb: name, sub, parentCmds: JSON.stringify(help.cmds) })
  }
  const secondHelp = await pooled(second, 6, async s => ({ s, help: parseHelp(await helpOf([s.verb, s.sub])) }))
  for (const { s, help } of secondHelp) {
    const echo = JSON.stringify(help.cmds) === rootCmdKey || (help.cmds.length > 0 && JSON.stringify(help.cmds) === s.parentCmds)
    if (!echo && help.opts.length > 0) verbFlags.set(s.key, flagsOfOpts(help.opts))
  }
  const cliFlags = new Set<string>([...verbFlags.values()].flatMap(s => [...s]))

  const readText = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const flagsIn = (files: string[]): Set<string> => new Set(files.flatMap(f => longFlagsOf(readText(f))))
  const fastFlags = flagsIn(['src/commands/host/index.ts', 'src/cli/godotEngineCli.ts', 'src/commands/feedback/feedback.tsx'])
  const toolingFiles = walkFiles(join(ROOT, 'scripts'), p => {
    const rel = p.slice(ROOT.length + 1)
    return /^scripts\/(vendor|ops|build|release|updater|distribution)\//.test(rel) && !/prove-|\/fixtures\/|\.test\./.test(rel) && /\.(ts|sh|mjs|ps1)$/.test(rel)
  }).map(p => p.slice(ROOT.length + 1))
  const toolingFlags = flagsIn(toolingFiles)

  const { builtinCommands } = await import('../../src/commands.ts')
  const slash = new Set<string>()
  for (const c of builtinCommands() as ReadonlyArray<{ name: string; aliases?: string[] }>) {
    slash.add(c.name)
    for (const a of c.aliases ?? []) slash.add(a)
  }
  const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
  const { getBundledSkills } = await import('../../src/skills/bundledSkills.ts')
  initBundledSkills()
  const skills = new Set((getBundledSkills() as ReadonlyArray<{ name: string }>).map(s => s.name))
  for (const s of skills) slash.add(s)
  const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')

  await import('../../src/tools.ts')
  const toolFiles = walkFiles(join(ROOT, 'src', 'tools'), p => /\.(ts|tsx)$/.test(p) && !/\.test\./.test(p))
  const tools = new Set<string>()
  for (const f of toolFiles) {
    try {
      const m = (await import(f)) as Record<string, unknown>
      const consider = (x: unknown): void => {
        const t = x as { name?: unknown; call?: unknown; aliases?: string[] } | null
        if (t !== null && typeof t === 'object' && typeof t.name === 'string' && typeof t.call === 'function') {
          tools.add(t.name)
          for (const a of t.aliases ?? []) tools.add(a)
        }
      }
      for (const val of Object.values(m)) {
        if (Array.isArray(val)) val.forEach(consider)
        else consider(val)
      }
    } catch {
      continue
    }
  }
  tools.delete('mcp')
  const grammar = readText('src/utils/hooks/matcherGrammar.ts').match(/PATH_TOOLS[^=]*=\s*new Set\(\[([^\]]*)\]/)
  const ruleTools = new Set([...(grammar?.[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map(m => m[1] ?? ''))

  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  type Z = { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown>; shape?: Record<string, Z> }
  const settingsPaths: string[][] = []
  const enums = new Map<string, string[]>()
  const walk = (schema: Z, prefix: string[], depth: number): void => {
    const def = (schema?._zod?.def ?? schema?.def) as Record<string, unknown> | undefined
    if (!def || depth > 9) return
    const type = def.type as string
    const key = prefix.join('.')
    if (type === 'enum') {
      enums.set(key, [...new Set([...(enums.get(key) ?? []), ...Object.values(def.entries as Record<string, string>).map(String)])])
      return
    }
    if (type === 'literal') {
      enums.set(key, [...new Set([...(enums.get(key) ?? []), ...(def.values as unknown[]).map(String)])])
      return
    }
    if (type === 'object') {
      const shape = (def.shape ?? schema.shape) as Record<string, Z>
      for (const [k, val] of Object.entries(shape ?? {})) {
        settingsPaths.push([...prefix, k])
        walk(val, [...prefix, k], depth + 1)
      }
      return
    }
    if (type === 'record') {
      settingsPaths.push([...prefix, '*'])
      walk(def.valueType as Z, [...prefix, '*'], depth + 1)
      return
    }
    for (const k of ['innerType', 'in', 'out', 'schema', 'element', 'getter']) {
      const inner = def[k] as Z | (() => Z) | undefined
      if (inner) walk(typeof inner === 'function' ? (inner as () => Z)() : inner, prefix, depth + 1)
    }
    if (Array.isArray(def.options)) for (const o of def.options as Z[]) walk(o, prefix, depth + 1)
  }
  walk((SettingsSchema as unknown as () => Z)(), [], 0)
  const settingsTop = new Set(settingsPaths.filter(p => p.length === 1).map(p => p[0]!))

  const { HOOK_EVENTS } = await import('../../src/utils/hooks/contract.ts')
  const hookEvents = new Set<string>(HOOK_EVENTS as readonly string[])

  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const chords: string[] = []
  for (const block of DEFAULT_BINDINGS as ReadonlyArray<{ bindings: Record<string, string> }>) for (const k of Object.keys(block.bindings)) chords.push(k.toLowerCase())

  const srcFiles = walkFiles(join(ROOT, 'src'), p => /\.(ts|tsx|js|mjs)$/.test(p) && !/\.test\.|\.generated\.|constants\/changelog\.ts$|\/skills\/bundled\//.test(p))
  const extraFiles = [...toolingFiles, 'build.ts', 'assets/splash/splash-core.mjs', 'assets/splash/mercury-splash.mjs', 'assets/splash/launcher-action-block.sh'].filter(f => existsSync(join(ROOT, f)))
  const envCorpus = new Set<string>()
  const productParts: string[] = []
  const glyphLiterals = new Map<string, string>()
  const srcChords = new Set<string>()
  const pathSegments = new Set<string>()
  const addSegments = (s: string): void => {
    for (const seg of s.split(/[/\\]/)) if (seg !== '') pathSegments.add(seg)
  }
  for (const f of [...srcFiles, ...extraFiles.map(r => join(ROOT, r))]) {
    const body = readFileSync(f, 'utf8')
    productParts.push(body)
    for (const m of body.matchAll(/(['"`])((?:(?!\1)[^\n\\]){14,160})\1/g)) {
      const typed = m[2] ?? ''
      if (!TYPOGRAPHY.test(typed) || /\$\{/.test(typed)) continue
      const plain = plainTypography(typed)
      if (plain !== typed && !glyphLiterals.has(plain)) glyphLiterals.set(plain, typed)
    }
    for (const m of body.matchAll(ENV_RE)) envCorpus.add(m[0])
    for (const m of body.matchAll(/['"`]([^'"`\n]{1,160})['"`]/g)) {
      const s = m[1] ?? ''
      addSegments(s)
      if (new RegExp(`^${MODS}\\+`, 'i').test(s)) for (const part of s.split(/\s+/)) srcChords.add(normaliseChord(part))
    }
    if (/\.(sh|ps1|cmd)$/.test(f)) for (const w of body.matchAll(/[A-Za-z0-9_.-]+/g)) pathSegments.add(w[0])
  }
  for (const m of readText('src/utils/model/modelPickerGroups.ts').matchAll(/ctrl\+\$\{[A-Z_]+\}/g)) srcChords.add(m[0])
  srcChords.add('ctrl+e')

  const tracked = new Set(git(['ls-files']).split('\n'))
  const repoPathExists = (p: string): boolean => {
    const clean = p.replace(/\/+$/, '')
    if (tracked.has(clean) || existsSync(join(ROOT, clean))) return true
    return [...tracked].some(t => t.startsWith(`${clean}/`))
  }
  const pkg = JSON.parse(readText('package.json')) as { scripts: Record<string, string> }

  const oauth = readText('src/components/ConsoleOAuthFlow.tsx')
  const rows = oauth.match(/READINESS_ROWS[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ''
  const ids = [...rows.matchAll(/id:\s*'([a-z-]+)'/g)].map(m => m[1] ?? '')
  const providerCount = ids.filter(id => id !== 'local' && id !== 'openai-compat').length

  const english = readText('README.md')
  const list = english.match(/keep all \d+ providers signed in at once \(([^)]*)\)/)?.[1] ?? ''
  const providerNames = list
    .replace(/, or your own local\/hosted weights$/, '')
    .split(/,\s*(?:or\s+)?/)
    .map(s => s.trim())
    .filter(Boolean)

  return {
    rootVerbs,
    verbSubs,
    verbFlags,
    cliFlags,
    fastFlags,
    toolingFlags,
    slash,
    skills,
    loginWord: word => parseFamilyFocus(word) !== undefined,
    tools,
    ruleTools,
    settingsPaths,
    settingsTop,
    enums,
    hookEvents,
    envCorpus,
    chords,
    srcChords,
    pathSegments,
    repoPathExists,
    packageScripts: new Set(Object.keys(pkg.scripts)),
    providerCount,
    providerNames,
    productText: productParts.join('\n'),
    glyphLiterals,
  }
}

function fakeVocab(): Vocab {
  return {
    rootVerbs: new Set(['run', 'health', 'sessions']),
    verbSubs: new Map([['sessions', new Set(['list', 'delete'])]]),
    verbFlags: new Map([
      ['', new Set(['--model'])],
      ['run', new Set(['--model', '--format'])],
      ['health', new Set(['--json'])],
      ['sessions', new Set(['--all'])],
    ]),
    cliFlags: new Set(['--model', '--format', '--json', '--all']),
    fastFlags: new Set(),
    toolingFlags: new Set(),
    slash: new Set(['health', 'logins']),
    skills: new Set(['loop']),
    loginWord: w => w === 'zai',
    tools: new Set(['Bash', 'Read']),
    ruleTools: new Set(['NotebookRead']),
    settingsPaths: [['engine'], ['engine', 'model'], ['engine', 'effort'], ['compatProvider'], ['compatProvider', '*'], ['compatProvider', '*', 'dialect']],
    settingsTop: new Set(['engine', 'compatProvider']),
    enums: new Map([['compatProvider.*.dialect', ['chat-completions', 'sglang']]]),
    hookEvents: new Set(['tool.before']),
    envCorpus: new Set(['MERCURY_CONFIG_DIR']),
    chords: ['ctrl+x y', 'shift+tab'],
    srcChords: new Set(),
    pathSegments: new Set(['settings.json', 'runtime']),
    repoPathExists: p => p === 'docs/README.md',
    packageScripts: new Set(['typecheck']),
    providerCount: 22,
    providerNames: ['Melious AI'],
    productText: 'Session Concourse at boot',
    glyphLiterals: new Map([["Machines I'm paying for", 'Machines I’m paying for']]),
  }
}

function selfTest(): void {
  const v = fakeVocab()
  const red: Array<[string, string, string]> = [
    ['flag', 'Run `mercury run --nonexistent-flag`.', 'docs/X.md'],
    ['verb', 'Run `mercury frobnicate` now.', 'docs/X.md'],
    ['verb-sub', 'Run `mercury sessions purge` now.', 'docs/X.md'],
    ['verb-flag', 'Run `mercury health --format rows` now.', 'docs/X.md'],
    ['slash', 'Type /frobnicate to start.', 'docs/X.md'],
    ['logins-family', 'Use `/logins nowhere` to sign in.', 'docs/X.md'],
    ['settings-key', 'Set `engine.nonsense` to true.', 'docs/X.md'],
    ['enum', '| Key | What it sets |\n| --- | --- |\n| `compatProvider.<name>.dialect` | `chat-completions` (default). |', 'docs/SETTINGS.md'],
    ['env', 'Set `MERCURY_NOT_A_REAL_NAME=1`.', 'docs/X.md'],
    ['tool', 'The `Frobnicate` tool reads files.', 'docs/X.md'],
    ['tool', 'Use `Frobnicate(*.ts)` as a rule.', 'docs/X.md'],
    ['skill', 'The `frobnicate` skill helps.', 'docs/X.md'],
    ['path', 'It lives at `<config home>/frobnicate/state.json`.', 'docs/X.md'],
    ['repo-path', 'See `src/nowhere/missing.ts`.', 'docs/X.md'],
    ['chord', 'Press `ctrl+q` to quit.', 'docs/X.md'],
    ['package-script', 'Run `bun run frobnicate`.', 'docs/X.md'],
    ['label', 'Open the `Frobnicate Panel Row` row.', 'docs/X.md'],
    ['glyph', "Open **Machines I'm paying for** to check.", 'docs/X.md'],
    ['count', 'We keep all 20 providers signed in at once (A, B).', 'README.md'],
    ['count', '- **20 X, `/llmhost` `/localsetup`:** A, OpenCode Zen, Melious AI\n\n20 families in total with OpenCode Zen', 'docs/translations/README.xx.md'],
    ['provider-name', '- **22 X, `/llmhost` `/localsetup`:** A, OpenCode Zen', 'docs/translations/README.xx.md'],
  ]
  for (const [kind, fixture, file] of red) {
    const found = checkDoc(file, fixture, v).filter(h => h.kind === kind)
    if (found.length === 0) {
      console.error(`self-test FAILED: a ${kind} fixture was not flagged: ${fixture.split('\n')[0]}`)
      process.exit(1)
    }
  }
  const clean = [
    'Run `mercury run --model x --format rows "hello"` or `mercury health --json`.',
    'Run `mercury sessions list --all` and `mercury sessions delete <id>`.',
    'Type /health, /logins or /loop; `/logins zai` signs in.',
    'Set `engine.model` and `compatProvider.<name>.dialect`.',
    '| Key | What it sets |\n| --- | --- |\n| `compatProvider.<name>.dialect` | `chat-completions` (default) or `sglang`. |',
    'Set `MERCURY_CONFIG_DIR` first.',
    'The `Bash` tool and `Read(*.ts)` and `NotebookRead(*.ts)` rules.',
    'It lives at `<config home>/runtime/settings.json`.',
    'See [the index](README.md) and `docs/README.md`.',
    'Press `ctrl+x y` or shift+tab, then `bun run typecheck`.',
    'Run `bun install --frozen-lockfile` first.',
    'Open the `Session Concourse at boot` row.',
    'Open **Machines I’m paying for** to check.',
  ].join('\n')
  const cleanHits = checkDoc('docs/SETTINGS.md', clean, v)
  if (cleanHits.length > 0) {
    console.error('self-test FAILED: clean text was flagged:')
    for (const h of cleanHits) console.error(`  ${h.kind} ${h.name}: ${h.detail}`)
    process.exit(1)
  }
}

selfTest()
const vocab = await buildVocab()
const hits: Hit[] = []
const pages = docPaths()
for (const page of pages) hits.push(...checkDoc(page, readDoc(page), vocab))
const seen = new Set<string>()
const unique = hits.filter(h => {
  const key = `${h.file}:${h.line}:${h.kind}:${h.name}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
const verb = REPORT ? 'hit' : 'FAIL'
for (const h of unique) console.error(`  [${verb}] ${h.file}:${h.line} ${h.kind} ${h.name} — ${h.detail}`)
console.log(`docs-names: ${pages.length} pages scanned${REV !== null ? ` at ${REV.slice(0, 10)}` : ''}, ${unique.length} name(s) the code does not carry`)
rmSync(HOME, { recursive: true, force: true })
if (unique.length > 0 && !REPORT) {
  console.error('❌ docs-names: the docs state names the code does not have as stated')
  process.exit(1)
}
console.log(REPORT ? 'docs-names: report mode (no verdict)' : '✅ docs-names: every name a page states exists in the code')
process.exit(0)
