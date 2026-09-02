// ============================================================================
//  src/extensions/load/contributions.ts — resolve ONE extension's manifest
//  against its folder and the machine: every declared contribution becomes
//  a resolved item or a one-line defect, in the probe order the health
//  readout paints. The loaders consume the resolved items; health consumes
//  the defects and notes. One resolver, so a row, a pane, /health and the
//  CLI can never disagree.
// ============================================================================
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { validateAgentIdentifier } from '../../services/agents/codec.js'
import { parseFrontmatter, type FrontmatterData } from '../../utils/frontmatterParser.js'
import {
  HOOK_EVENT_NAMES,
  type ExtensionManifest,
  type ManifestHookMatcher,
  type ManifestServer,
  resolveInsideRoot,
  serverRuntimeName,
} from '../manifest.js'
import { substituteRootAndData } from '../options.js'

// ── the resolved shapes ─────────────────────────────────────────────────────

export type ResolvedSkill = { name: string; skillName: string; dir: string; file: string; body: string; frontmatter: FrontmatterData }
export type ResolvedCommand = { name: string; file: string; body: string; frontmatter: FrontmatterData }
export type ResolvedAgent = { agentType: string; file: string; body: string; frontmatter: FrontmatterData; ignoredFields: string[] }
export type ResolvedHook = {
  event: string
  matcher: string | undefined
  hook: ManifestHookMatcher['hooks'][number]
  /** The command line after root/data substitution (options substitute at spawn). */
  commandLine: string
  /** The script the command runs, when it is a path inside the root. */
  scriptPath: string | null
}
export type ResolvedServer = { key: string; runtimeName: string; config: ManifestServer; transport: 'stdio' | 'http' | 'sse' }
export type ResolvedLanguage = { key: string; runtimeName: string; config: NonNullable<ExtensionManifest['contributes']>['language'] extends Record<string, infer T> | undefined ? T : never }
export type ResolvedChannel = { server: string; runtimeName: string; label: string }
export type ResolvedKeybinding = { chord: string; target: string; taken: boolean }

export type Resolution = {
  skills: ResolvedSkill[]
  commands: ResolvedCommand[]
  agents: ResolvedAgent[]
  hooks: ResolvedHook[]
  servers: ResolvedServer[]
  language: ResolvedLanguage[]
  channels: ResolvedChannel[]
  keybindings: ResolvedKeybinding[]
  /** One line each, in probe order. */
  defects: string[]
  /** Not defects: an agent's ignored privileged field, a chord left alone. */
  notes: string[]
}

/** The machine probes, injectable so provers can stand in for PATH, env and the keybindings. */
export type Probes = {
  onPath: (binary: string) => boolean
  envSet: (name: string) => boolean
  chordTaken: (chord: string) => boolean
  optionSet: (key: string) => boolean
}

// ── machine probes (the real ones) ──────────────────────────────────────────

const PATH_EXTS = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']

/** A bare name found on PATH, or an existing path. */
export function isOnPath(binary: string): boolean {
  if (binary === '') return false
  if (binary.includes('/') || binary.includes('\\')) return existsSync(binary)
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of PATH_EXTS) {
      const candidate = join(dir, binary + ext)
      try {
        const stat = statSync(candidate)
        if (!stat.isFile()) continue
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
        return true
      } catch {
        // keep looking
      }
    }
  }
  return false
}

export function isEnvSet(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value !== ''
}

export function realProbes(overrides: Partial<Probes> = {}): Probes {
  return {
    onPath: isOnPath,
    envSet: isEnvSet,
    chordTaken: () => false,
    optionSet: () => false,
    ...overrides,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/

// eslint-disable-next-line no-control-regex
const SKILL_NAME_HOSTILE = /[\x00-\x1f\x7f\s/\\:]/

/**
 * A skill's declared name becomes half of a slash command
 * (`/<extension>:<skill>`) and a line on the approval card's "reaches the
 * model" roster: no path separators or namespace colons, no whitespace,
 * no control characters, no leading dot, 1–64 characters. The folder-name
 * fallback never passes through here — directory entries cannot spell
 * traversal.
 */
function isLegalSkillName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (name.startsWith('.')) return false
  return !SKILL_NAME_HOSTILE.test(name)
}

/** Read a markdown file; `parsed: false` when a frontmatter block is present but yields nothing. */
function readMarkdown(file: string): { body: string; frontmatter: FrontmatterData; parsed: boolean } | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const md = parseFrontmatter(raw, file)
  const block = FRONTMATTER_BLOCK.exec(raw)
  // A thrown parse failure arrives TYPED on the result (fail closed, one
  // law with the skills and agents loaders); a present block that yields
  // no object (valid YAML of the wrong shape) is the same refusal from
  // the maker's view.
  const parsed = md.parseError === undefined && !(block && block[1]!.trim() !== '' && Object.keys(md.frontmatter).length === 0)
  return { body: md.content, frontmatter: md.frontmatter, parsed }
}

function listDir(dir: string): Array<{ name: string; isDir: boolean }> | null {
  try {
    return readdirSync(dir, { withFileTypes: true }).map(entry => {
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, entry.name)).isDirectory()
        } catch {
          isDir = false
        }
      }
      return { name: entry.name, isDir }
    })
  } catch {
    return null
  }
}

function isExecutable(path: string): boolean {
  if (process.platform === 'win32') return existsSync(path)
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'node', 'bun', 'python', 'python3', 'ruby', 'perl', 'pwsh', 'powershell', 'deno'])

/** Split a command line into rough tokens (double/single quotes respected). */
export function tokenise(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) out.push(current)
  return out
}

/** The script a hook runs when it is a path inside the root: the first
 *  token, or the second behind a bare interpreter. A path-shaped token that
 *  ESCAPES the root answers { escaped } so the caller can record the defect
 *  — it used to fold into null and the hook was silently counted (C15). A
 *  bare PATH command (no path shape anywhere) stays null: nothing to
 *  contain. */
export function hookScriptPath(
  commandLine: string,
  root: string,
): { path: string; direct: boolean } | { escaped: string } | null {
  const tokens = tokenise(commandLine)
  const first = tokens[0]
  if (!first) return null
  const pathShaped = (token: string): boolean => isAbsolute(token) || token.startsWith('.')
  const inside = (token: string): string | null => {
    const abs = resolve(root, token)
    return resolveInsideRoot(root, abs) !== null ? abs : null
  }
  if (pathShaped(first)) {
    const direct = inside(first)
    return direct !== null ? { path: direct, direct: true } : { escaped: first }
  }
  if (INTERPRETERS.has(basename(first)) && tokens[1] && pathShaped(tokens[1])) {
    const script = inside(tokens[1])
    return script !== null ? { path: script, direct: false } : { escaped: tokens[1] }
  }
  return null
}

// ── the resolver ────────────────────────────────────────────────────────────

const SKILL_FILE = 'SKILL.md'

export function resolveContributions(
  manifest: ExtensionManifest,
  root: string,
  id: string,
  probes: Probes = realProbes(),
): Resolution {
  const name = manifest.name
  const c = manifest.contributes ?? {}
  const needs = manifest.needs ?? {}
  const defects: string[] = []
  const notes: string[] = []
  const result: Resolution = {
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    servers: [],
    language: [],
    channels: [],
    keybindings: [],
    defects,
    notes,
  }
  const substitute = (text: string): string => substituteRootAndData(text, root, id)

  // 1. skills / commands / agents directories
  for (const dir of c.skills ?? []) {
    const abs = resolveInsideRoot(root, dir)
    if (abs === null) continue // a manifest error, caught before resolution
    const entries = listDir(abs)
    if (entries === null) {
      defects.push(`skills ${dir}: folder missing`)
      continue
    }
    let loaded = 0
    // The root's own SKILL.md makes the directory itself one skill.
    const own = existsSync(join(abs, SKILL_FILE)) ? [{ name: basename(abs), isDir: true, self: true }] : []
    const candidates = own.length > 0 ? own : entries.filter(e => e.isDir).map(e => ({ ...e, self: false }))
    for (const entry of candidates) {
      const skillDir = entry.self ? abs : join(abs, entry.name)
      const file = join(skillDir, SKILL_FILE)
      if (!existsSync(file)) continue
      const md = readMarkdown(file)
      if (md === null || !md.parsed) {
        defects.push(`skill ${dir}/${entry.name}/${SKILL_FILE}: frontmatter did not parse — skipped`)
        continue
      }
      const declaredName = typeof md.frontmatter['name'] === 'string' && md.frontmatter['name'].trim() ? md.frontmatter['name'].trim() : null
      // A declared name becomes half of a slash command and a line on the
      // approval card's "reaches the model" roster: a hostile spelling is
      // a refusal (typed defect naming the FILE, never echoing the name),
      // never a silent rename.
      if (declaredName !== null && !isLegalSkillName(declaredName)) {
        defects.push(`skill ${dir}/${entry.name}/${SKILL_FILE}: name in frontmatter is not a legal skill name — skipped`)
        continue
      }
      const skillName = declaredName ?? entry.name
      result.skills.push({ name: `${name}:${skillName}`, skillName, dir: skillDir, file, body: md.body, frontmatter: md.frontmatter })
      loaded++
    }
    if (loaded === 0) defects.push(`skills ${dir}: no skill found (a skill is a folder holding ${SKILL_FILE})`)
  }

  for (const dir of c.commands ?? []) {
    const abs = resolveInsideRoot(root, dir)
    if (abs === null) continue
    const entries = listDir(abs)
    if (entries === null) {
      defects.push(`commands ${dir}: folder missing`)
      continue
    }
    let loaded = 0
    // FC-123: the namespace contract is ONE folder deep — but a .md buried
    // deeper used to vanish with the same command count and the same
    // contributions hash as if the file were not there. The exclusion is
    // now a named defect (only when the deeper tree actually holds a .md;
    // an empty folder is not a finding).
    const holdsMarkdownAnywhere = (folder: string): boolean => {
      for (const item of listDir(folder) ?? []) {
        if (item.isDir) {
          if (holdsMarkdownAnywhere(join(folder, item.name))) return true
        } else if (extname(item.name).toLowerCase() === '.md') {
          return true
        }
      }
      return false
    }
    const visit = (folder: string, namespace: string[], depth: number): void => {
      const items = listDir(folder) ?? []
      for (const item of items) {
        if (item.isDir) {
          if (depth === 0) {
            visit(join(folder, item.name), [...namespace, item.name], 1)
          } else if (holdsMarkdownAnywhere(join(folder, item.name))) {
            defects.push(
              `command ${dir}/${[...namespace, item.name].join('/')}: nested deeper than one level — its .md files are not loaded (the commands namespace is one folder deep)`,
            )
          }
          continue
        }
        if (extname(item.name).toLowerCase() !== '.md') continue
        const file = join(folder, item.name)
        const md = readMarkdown(file)
        if (md === null || !md.parsed) {
          defects.push(`command ${dir}/${[...namespace, item.name].join('/')}: frontmatter did not parse — skipped`)
          continue
        }
        const commandName = [name, ...namespace, item.name.replace(/\.md$/i, '')].join(':')
        result.commands.push({ name: commandName, file, body: md.body, frontmatter: md.frontmatter })
        loaded++
      }
    }
    visit(abs, [], 0)
    if (loaded === 0) defects.push(`commands ${dir}: no command found (a command is a <cmd>.md prompt file)`)
  }

  const PRIVILEGED = ['permissionMode', 'hooks', 'mcpServers', 'servers'] as const
  for (const dir of c.agents ?? []) {
    const abs = resolveInsideRoot(root, dir)
    if (abs === null) continue
    const entries = listDir(abs)
    if (entries === null) {
      defects.push(`agents ${dir}: folder missing`)
      continue
    }
    let loaded = 0
    for (const entry of entries) {
      if (entry.isDir || extname(entry.name).toLowerCase() !== '.md') continue
      const file = join(abs, entry.name)
      const md = readMarkdown(file)
      if (md === null || !md.parsed) {
        defects.push(`agent ${dir}/${entry.name}: frontmatter did not parse — skipped`)
        continue
      }
      const base = typeof md.frontmatter['name'] === 'string' && md.frontmatter['name'].trim() ? md.frontmatter['name'].trim() : entry.name.replace(/\.md$/i, '')
      // The agents estate's own identifier law, at this loading door too —
      // the base becomes half of agentType and a path segment downstream.
      // The defect names the file, never echoing the hostile name.
      if (validateAgentIdentifier(base) !== null) {
        defects.push(`agent ${dir}/${entry.name}: name is not a legal agent identifier — skipped`)
        continue
      }
      const ignored = PRIVILEGED.filter(field => md.frontmatter[field] !== undefined && md.frontmatter[field] !== null)
      const agentType = `${name}:${base}`
      for (const field of ignored) notes.push(`agent ${base}: ${field} field ignored`)
      result.agents.push({ agentType, file, body: md.body, frontmatter: md.frontmatter, ignoredFields: [...ignored] })
      loaded++
    }
    if (loaded === 0) defects.push(`agents ${dir}: no agent found (an agent is an <agent>.md definition)`)
  }

  // 2. hooks
  for (const [event, matchers] of Object.entries(c.hooks ?? {})) {
    if (!HOOK_EVENT_NAMES.has(event)) {
      defects.push(`hook ${event}: not a hook event Mercury fires — skipped`)
      continue
    }
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const commandLine = substitute(hook.command)
        const script = hookScriptPath(commandLine, root)
        // C15: a path-shaped script ESCAPING the extension root used to fold
        // into "no script" and the hook was silently counted — an extension
        // running code outside its own estate with no word anywhere.
        if (script !== null && 'escaped' in script) {
          defects.push(`hook ${event}: script ${script.escaped} escapes the extension root — skipped`)
          continue
        }
        let scriptPath: string | null = null
        if (script) {
          scriptPath = script.path
          if (!existsSync(script.path)) {
            defects.push(`hook ${basename(script.path)}: file missing (${event})`)
            continue
          }
          if (script.direct && !isExecutable(script.path)) {
            defects.push(`hook ${basename(script.path)}: not executable (${event}) — chmod +x fixes it`)
            continue
          }
        }
        result.hooks.push({ event, matcher: matcher.matcher, hook, commandLine, scriptPath })
      }
    }
  }

  // 3. servers, language servers, channels
  for (const [key, config] of Object.entries(c.servers ?? {})) {
    const transport = ('type' in config && config.type ? config.type : 'stdio') as 'stdio' | 'http' | 'sse'
    const runtimeName = serverRuntimeName(name, key)
    if (transport === 'stdio') {
      const command = substitute((config as { command: string }).command)
      const isPath = command.includes('/') || command.includes('\\')
      if (isPath ? !existsSync(command) : !probes.onPath(command)) {
        defects.push(`server ${key}: ${command} not on PATH`)
        continue
      }
    }
    result.servers.push({ key, runtimeName, config, transport })
  }
  for (const [key, config] of Object.entries(c.language ?? {})) {
    const command = substitute(config.command)
    const isPath = command.includes('/') || command.includes('\\')
    if (isPath ? !existsSync(command) : !probes.onPath(command)) {
      defects.push(`language ${key}: ${command} not on PATH`)
      continue
    }
    result.language.push({ key, runtimeName: serverRuntimeName(name, key), config })
  }
  for (const channel of c.channels ?? []) {
    if (!(c.servers ?? {})[channel.server]) {
      defects.push(`channel "${channel.label}": names no server "${channel.server}"`)
      continue
    }
    result.channels.push({ server: channel.server, runtimeName: serverRuntimeName(name, channel.server), label: channel.label })
  }

  // 4. needs
  for (const binary of needs.binaries ?? []) {
    if (!probes.onPath(binary)) defects.push(`${binary} not on PATH`)
  }
  for (const env of needs.env ?? []) {
    if (!probes.envSet(env)) defects.push(`${env} unset`)
  }
  for (const [key, option] of Object.entries(needs.options ?? {})) {
    if (option.required && option.default === undefined && !probes.optionSet(key)) defects.push(`option ${key} not set — o edits`)
  }

  // 5. keybindings
  const ownTargets = new Set<string>([...result.skills.map(s => `/${s.name}`), ...result.commands.map(cmd => `/${cmd.name}`)])
  for (const [chord, target] of Object.entries(c.keybindings ?? {})) {
    if (!target.startsWith(`/${name}:`)) {
      defects.push(`keybinding ${chord}: ${target} is not this extension's command`)
      continue
    }
    if (!ownTargets.has(target)) {
      defects.push(`keybinding ${chord}: ${target} is not declared by this extension`)
      continue
    }
    const taken = probes.chordTaken(chord)
    if (taken) notes.push(`keybinding ${chord}: already bound — left alone`)
    result.keybindings.push({ chord, target, taken })
  }

  return result
}
