// ============================================================================
//  src/skills/loadSkillsDir.ts — skill discovery, parsing and the merged
//  catalogue: managed/user/project/added-dir skills, legacy commands, the
//  conditional (path-filtered) split, and mid-session dynamic discovery.
//
//  (The snapshot's MCP-builder registration tail is not built — the registry
//  it fed was write-once with no reader; the constraint it worked around is
//  a recorded decision.)
// ============================================================================
import { existsSync, promises as fsPromises } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { memoize } from 'lodash-es'
import ignore from 'ignore'
import type { Command, PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { HooksSettings } from '../schemas/hooks.js'
import { HooksSchema } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import { parseEffortValue, EFFORT_LEVELS } from '../utils/effort.js'
import {
  parseFrontmatter,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
  coerceDescriptionToString,
  type FrontmatterShell,
} from '../utils/frontmatterParser.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
  clearMarkdownFileCache,
  parseSlashCommandToolsFromFrontmatter,
} from '../utils/markdownConfigLoader.js'
import { parseArgumentNames, substituteArguments } from '../utils/argumentSubstitution.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import {
  PROJECT_CONFIG_DIR_NAMES,
  projectConfigCandidatePaths,
} from '../utils/projectConfig.js'
import { getMercuryHome, isBareMode, isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import { getManagedFilePath } from '../utils/settings/managedPath.js'
import {
  getEnabledSettingSources,
  isSettingSourceEnabled,
  type SettingSource,
} from '../utils/settings/constants.js'
import { isRestrictedToExtensionsOnly } from '../utils/settings/extensionOnlyPolicy.js'
import { isPathGitignored } from '../utils/git/gitignore.js'
import { getSessionId, getAddedDirectories } from '../bootstrap/state.js'
import { createSignal } from '../utils/signal.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { errorMessage, isENOENT, isFsInaccessible } from '../utils/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'

/** Where a command was loaded from (the origin labels). */
export type LoadedFrom =
  | 'legacy-commands'
  | 'skills'
  | 'extension'
  | 'managed'
  | 'bundled'
  | 'mcp'

const SKILL_FILE_NAME = 'SKILL.md'
const SKILL_FALLBACK_LABEL = 'skill'
const COMMAND_FALLBACK_LABEL = 'custom command'

// ── the typed refusal channel (E008-53) ────────────────────────────────────

/** One refused skill file: the path, the typed reason, the origin label. */
export type SkillLoadRefusal = { path: string; error: string; source: string }

// Keyed by file path; repopulated as loads run, cleared with the caches.
// The law: a frontmatter PARSE FAILURE fails CLOSED — the skill is refused
// with a typed reason, never built from the permissive defaults an empty
// frontmatter implies (the author's opt-outs would silently vanish). This
// channel is the machine-visible record; the human paint rides the health
// estate.
const skillLoadRefusals = new Map<string, SkillLoadRefusal>()

function recordSkillRefusal(path: string, error: string, source: string): void {
  skillLoadRefusals.set(path, { path, error, source })
}

/**
 * A slash-command name must be PRODUCIBLE by parseSlashCommand: one
 * non-empty, whitespace-free token after the slash (FC-122). A file named
 * `.md` derived the empty name and `w5 has space.md` derived one with a
 * space — both listed in the roster, neither ever invocable. Names that
 * cannot be typed are refused through the same channel as parse failures.
 */
export function slashNameProblem(name: string): string | null {
  if (name === '' || name.endsWith(':') || name.startsWith(':')) {
    return 'derives an empty command name — no name to invoke'
  }
  if (/\s/.test(name)) {
    return `contains whitespace ('/${name}' can never be one command token)`
  }
  return null
}

/** Every refused skill file from the loads since the last cache clear. */
export function getSkillLoadRefusals(): SkillLoadRefusal[] {
  return [...skillLoadRefusals.values()]
}

/** The words for a SKILL.md with nothing in it — no frontmatter, no body:
 *  refused, never offered as a blank skill under the directory's name. */
export const EMPTY_SKILL_FILE_REASON = 'the file is empty — no frontmatter, no body'

/** The frontmatter keys whose value is an author's OPT-OUT (E008-53): a
 *  spelling the parser cannot read as a boolean would silently land on the
 *  permissive side (`disable-model-invocation: maybe` read as "not
 *  disabled"), so an unreadable value refuses the skill through the same
 *  channel as a parse failure — the reason names the key and the value. */
const BOOLEAN_OPT_OUT_KEYS = ['disable-model-invocation', 'user-invocable'] as const

/** One frontmatter problem that must fail CLOSED, or null when the fields
 *  read cleanly (unknown keys pass — a skill written for another harness
 *  keeps loading; only a known key with an unreadable value refuses). */
export function skillFrontmatterProblem(frontmatter: Record<string, unknown>): string | null {
  for (const key of BOOLEAN_OPT_OUT_KEYS) {
    const value = frontmatter[key]
    if (value === undefined || value === null) continue
    if (value === true || value === false || value === 'true' || value === 'false') continue
    return `frontmatter key ${key}: "${String(value)}" is not true or false`
  }
  return null
}

// ── C.1 where skills come from ─────────────────────────────────────────────

/**
 * Every EXISTING project home path for `dir` (`skills` or `commands`),
 * `.mercury` first — the watcher uses this so a skill in ANY home
 * hot-reloads. Load and watch must cover the same set.
 */
export function getProjectSkillsWatchPaths(
  dir: 'skills' | 'commands',
  cwd: string = process.cwd(),
): string[] {
  // Candidates REGARDLESS of existence: a watcher must see the home that
  // does not exist yet — its creation is the event (release-hardening
  // audit rank 28). The loaders keep the existing-only derivation.
  return projectConfigCandidatePaths(cwd, dir)
}

/**
 * The directory for a settings source; the literal `extension` sentinel for
 * the extension source, and an empty string for anything unrecognised.
 */
export function getSkillsPath(source: SettingSource | 'extension', dir: string): string {
  switch (source) {
    case 'userSettings':
      return join(getMercuryHome(), dir)
    case 'policySettings':
      // The managed tree uses Mercury's own directory name.
      return join(getManagedFilePath(), '.mercury', dir)
    case 'projectSettings':
    case 'localSettings':
      return join(process.cwd(), '.mercury', dir)
    case 'extension':
      return 'extension'
    default:
      return ''
  }
}

// ── C.3 frontmatter parsing ────────────────────────────────────────────────

export type ParsedSkillFrontmatterFields = {
  description: string
  hasUserSpecifiedDescription: boolean
  displayName?: string
  allowedTools: string[]
  argumentHint?: string
  argNames?: string[]
  whenToUse?: string
  version?: string
  model?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks?: HooksSettings
  context?: 'fork'
  agent?: string
  effort?: EffortValue
  shell?: FrontmatterShell
}

/**
 * The one shared parser both file-based and MCP-discovered skills use. The
 * caller supplies the resolved name and a fallback label.
 */
export function parseSkillFrontmatterFields(
  frontmatter: Record<string, unknown>,
  markdownContent: string,
  resolvedName: string,
  fallbackLabel: 'skill' | 'custom command' = SKILL_FALLBACK_LABEL,
): ParsedSkillFrontmatterFields {
  const userDescription = coerceDescriptionToString(frontmatter['description'])
  const description =
    userDescription ?? extractDescriptionFromMarkdown(markdownContent, fallbackLabel)

  const displayName =
    frontmatter['name'] !== undefined ? String(frontmatter['name']) : undefined

  let hooks: HooksSettings | undefined
  if (frontmatter['hooks'] !== undefined) {
    const validated = HooksSchema().safeParse(frontmatter['hooks'])
    if (validated.success) {
      hooks = validated.data as HooksSettings
    } else {
      logForDebugging(
        `skill ${resolvedName}: invalid hooks frontmatter ignored (${validated.error.message})`,
      )
    }
  }

  let model: string | undefined
  const rawModel = frontmatter['model']
  if (rawModel !== undefined && rawModel !== null) {
    model = String(rawModel) === 'inherit' ? undefined : parseUserSpecifiedModel(String(rawModel))
  }

  let effort: EffortValue | undefined
  const rawEffort = frontmatter['effort']
  if (rawEffort !== undefined && rawEffort !== null) {
    effort = parseEffortValue(rawEffort)
    if (effort === undefined) {
      logForDebugging(
        `skill ${resolvedName}: unrecognised effort "${String(rawEffort)}" — valid values: ${EFFORT_LEVELS.join(', ')}, or an integer`,
      )
    }
  }

  return {
    description,
    hasUserSpecifiedDescription: userDescription !== null,
    displayName,
    allowedTools: parseSlashCommandToolsFromFrontmatter(frontmatter['allowed-tools']),
    argumentHint:
      frontmatter['argument-hint'] !== undefined
        ? String(frontmatter['argument-hint'])
        : undefined,
    argNames: parseArgumentNames(
      frontmatter['arguments'] as string | string[] | undefined,
    ),
    whenToUse:
      frontmatter['when_to_use'] !== undefined
        ? String(frontmatter['when_to_use'])
        : undefined,
    version:
      frontmatter['version'] !== undefined ? String(frontmatter['version']) : undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(frontmatter['disable-model-invocation']),
    userInvocable:
      frontmatter['user-invocable'] === undefined
        ? true
        : parseBooleanFrontmatter(frontmatter['user-invocable']),
    hooks,
    context: frontmatter['context'] === 'fork' ? 'fork' : undefined,
    agent: frontmatter['agent'] !== undefined ? String(frontmatter['agent']) : undefined,
    effort,
    shell: parseShellFrontmatter(frontmatter['shell'], resolvedName),
  }
}

/**
 * Path filters (file-based skills only): split `paths`, strip a trailing
 * `/**` (the matcher already covers directory contents), drop empties. No
 * remaining patterns — or every pattern exactly `**` — means "no filter":
 * a match-all filter must not turn the skill conditional.
 */
function parseSkillPathFilters(frontmatter: Record<string, unknown>): string[] | undefined {
  const raw = frontmatter['paths']
  if (raw === undefined || raw === null) return undefined
  const patterns = splitPathInFrontmatter(raw as string | string[])
    .map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -'/**'.length) : pattern))
    .filter(pattern => pattern !== '')
  if (patterns.length === 0) return undefined
  if (patterns.every(pattern => pattern === '**')) return undefined
  return patterns
}

// ── C.4 building the command ───────────────────────────────────────────────

// Mercury's template tokens — the only spellings a skill body expands; any
// other product's template spelling stays literal in the body.
const SKILL_DIR_TOKEN = /\$\{MERCURY_SKILL_DIR\}/g
const SESSION_ID_TOKEN = /\$\{MERCURY_SESSION_ID\}/g

/** Skill self-auth flag (default-on): every ordinary falsy spelling turns
 *  it off — 0/false/no/off, any case, whitespace-trimmed (FC-159, the
 *  FC-006 vocabulary; isEnvDefinedFalsy is the one falsy reader). The old
 *  exact-byte '0' contract left 'false', 'off' and even ' 0' granting
 *  skills their own tool permissions. */
export function isSkillSelfAuthEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_SKILL_SELF_AUTH'))
}

export function createSkillCommand(options: {
  name: string
  markdownContent: string
  source: SettingSource | 'extension' | 'builtin' | 'mcp' | 'bundled'
  baseDir?: string
  loadedFrom: LoadedFrom
  fields: ParsedSkillFrontmatterFields
  pathFilters?: string[]
}): Command {
  const { name, markdownContent, source, baseDir, loadedFrom, fields, pathFilters } = options

  const getPromptForCommand: PromptCommand['getPromptForCommand'] = async (
    args,
    context,
  ) => {
    let content = markdownContent
    // 1. The base-directory line (disk-based and bundled skills share it).
    if (baseDir !== undefined) {
      content = `Base directory for this skill: ${baseDir} (read or grep files under it for the skill's own references)\n\n${content}`
    }
    // 2. Argument substitution (named + positional/$ARGUMENTS).
    content = substituteArguments(content, args, true, fields.argNames)
    // 3./4. Mercury's template tokens, globally. On Windows the substituted
    // directory uses forward slashes so shell commands do not treat
    // backslashes as escapes.
    if (baseDir !== undefined) {
      const dirForShell = process.platform === 'win32' ? baseDir.replaceAll('\\', '/') : baseDir
      content = content.replace(SKILL_DIR_TOKEN, dirForShell)
    }
    const sessionId = getSessionId()
    content = content.replace(SESSION_ID_TOKEN, String(sessionId))
    // 5. Inline shell — NEVER for MCP-loaded skills (remote and untrusted).
    if (loadedFrom !== 'mcp') {
      const wrappedContext = wrapContextForSkillSelfAuth(context, fields.allowedTools)
      content = await executeShellCommandsInPrompt(
        content,
        wrappedContext,
        `/${name}`,
        fields.shell,
      )
    }
    // 6. One text block.
    return [{ type: 'text', text: content }]
  }

  const command: PromptCommand = {
    type: 'prompt',
    name,
    getPromptForCommand,
    description: fields.description,
    hasUserSpecifiedDescription: fields.hasUserSpecifiedDescription,
    allowedTools: fields.allowedTools,
    ...(fields.argumentHint !== undefined ? { argumentHint: fields.argumentHint } : {}),
    ...(fields.argNames && fields.argNames.length > 0 ? { argNames: fields.argNames } : {}),
    ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
    ...(fields.version !== undefined ? { version: fields.version } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    disableModelInvocation: fields.disableModelInvocation,
    userInvocable: fields.userInvocable,
    ...(fields.context !== undefined ? { context: fields.context } : {}),
    ...(fields.agent !== undefined ? { agent: fields.agent } : {}),
    ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
    ...(pathFilters !== undefined ? { pathFilters } : {}),
    contentLength: markdownContent.length,
    isHidden: !fields.userInvocable,
    progressMessage: 'running',
    userFacingName: () => fields.displayName ?? name,
    source,
    loadedFrom,
    ...(fields.hooks !== undefined ? { hooks: fields.hooks } : {}),
    ...(baseDir !== undefined ? { skillRoot: baseDir } : {}),
  }
  return command
}

/**
 * Skill self-auth: while the inline-shell pass runs, the tool-use context's
 * app-state getter returns a permission context whose always-allow rules
 * carry the skill's own allowed-tools under the COMMAND rule-source key —
 * REPLACING any existing entry under that key for the duration (the
 * skill's list is spread last). Wrapping happens inside the getter, so it
 * re-derives per call and never mutates the caller's stored state. Gated
 * by MERCURY_SKILL_SELF_AUTH (off for every ordinary falsy spelling —
 * isEnvDefinedFalsy); when off the
 * wrapper contributes an empty object and the caller's context passes
 * through unchanged.
 */
function wrapContextForSkillSelfAuth(
  context: ToolUseContext,
  allowedTools: string[],
): ToolUseContext {
  return {
    ...context,
    getAppState: () => {
      const state = context.getAppState()
      const grant = isSkillSelfAuthEnabled() ? { command: allowedTools } : {}
      return {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          alwaysAllowRules: {
            ...state.toolPermissionContext.alwaysAllowRules,
            ...grant,
          },
        },
      }
    },
  }
}

/**
 * Token estimate for a skill: name, description and when-to-use joined by
 * spaces — the body is not loaded until invocation, so it is not counted.
 */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  return roughTokenCountEstimation(
    [skill.name, skill.description, skill.whenToUse ?? ''].join(' '),
  )
}

// ── C.2 reading a skills directory ─────────────────────────────────────────

type LoadedSkill = { command: Command; filePath: string; source: string }

async function loadSkillsFromDir(
  dir: string,
  source: SettingSource | 'extension',
  sourceLabel: string,
): Promise<LoadedSkill[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (!isENOENT(error) && !isFsInaccessible(error as Error)) {
      logForDebugging(`skills: could not read directory ${dir}: ${errorMessage(error)}`)
    }
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry): Promise<LoadedSkill | null> => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return null
      const skillDir = join(dir, entry.name)
      const skillFile = join(skillDir, SKILL_FILE_NAME)
      let markdown: string
      try {
        markdown = await fsPromises.readFile(skillFile, 'utf8')
      } catch (error) {
        if (!isENOENT(error)) {
          logForDebugging(
            `skills: could not read ${skillFile}: ${errorMessage(error)}`,
            { level: 'warn' },
          )
        }
        return null
      }
      try {
        if (markdown.trim() === '') {
          recordSkillRefusal(skillFile, EMPTY_SKILL_FILE_REASON, sourceLabel)
          return null
        }
        const parsed = parseFrontmatter(markdown, skillFile)
        if (parsed.parseError) {
          recordSkillRefusal(skillFile, `frontmatter did not parse: ${parsed.parseError.message}`, sourceLabel)
          return null
        }
        const fieldProblem = skillFrontmatterProblem(parsed.frontmatter)
        if (fieldProblem !== null) {
          recordSkillRefusal(skillFile, fieldProblem, sourceLabel)
          return null
        }
        const nameProblem = slashNameProblem(entry.name)
        if (nameProblem !== null) {
          recordSkillRefusal(skillFile, `uninvocable name: ${nameProblem}`, sourceLabel)
          return null
        }
        const fields = parseSkillFrontmatterFields(
          parsed.frontmatter,
          parsed.content,
          entry.name,
          SKILL_FALLBACK_LABEL,
        )
        const pathFilters = parseSkillPathFilters(parsed.frontmatter)
        const command = createSkillCommand({
          name: entry.name,
          markdownContent: parsed.content,
          source,
          baseDir: skillDir,
          loadedFrom: 'skills',
          fields,
          pathFilters,
        })
        return { command, filePath: skillFile, source: sourceLabel }
      } catch (error) {
        logForDebugging(`skills: failed to load ${skillFile}: ${errorMessage(error)}`)
        return null
      }
    }),
  )
  return results.filter((r): r is LoadedSkill => r !== null)
}

// ── legacy commands (C.2 second half) ──────────────────────────────────────

type MarkdownFileEntry = {
  filePath: string
  baseDir: string
  frontmatter: Record<string, unknown>
  content: string
  source: 'policySettings' | 'userSettings' | 'projectSettings'
  parseError?: { message: string }
}

/**
 * Group legacy command files by directory, keep only the first skill-named
 * file per directory (debug-logging the choice when there were several),
 * compute names/namespaces, and build commands. Exported for tests.
 */
export function transformSkillFiles(files: MarkdownFileEntry[]): LoadedSkill[] {
  const byDir = new Map<string, MarkdownFileEntry[]>()
  for (const file of files) {
    const dir = dirname(file.filePath)
    const list = byDir.get(dir) ?? []
    list.push(file)
    byDir.set(dir, list)
  }
  const kept: Array<{ file: MarkdownFileEntry; isSkillForm: boolean }> = []
  for (const [dir, list] of byDir) {
    const skillNamed = list.filter(
      file => basename(file.filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase(),
    )
    if (skillNamed.length > 0) {
      const [chosen] = skillNamed
      if (skillNamed.length > 1) {
        logForDebugging(
          `legacy commands: ${dir} holds ${skillNamed.length} skill files — keeping ${chosen!.filePath}`,
        )
      }
      kept.push({ file: chosen!, isSkillForm: true })
      // The sibling .md files still register as ordinary commands (FC-057):
      // a SKILL.md used to claim the whole directory — three files on disk,
      // one command registered, nothing on any channel.
      for (const file of list) {
        if (file !== chosen && basename(file.filePath).toLowerCase() !== SKILL_FILE_NAME.toLowerCase()) {
          kept.push({ file, isSkillForm: false })
        }
      }
    } else {
      for (const file of list) kept.push({ file, isSkillForm: false })
    }
  }
  const out: LoadedSkill[] = []
  for (const { file, isSkillForm } of kept) {
    if (file.parseError) {
      recordSkillRefusal(file.filePath, `frontmatter did not parse: ${file.parseError.message}`, 'legacy-commands')
      continue
    }
    const fieldProblem = skillFrontmatterProblem(file.frontmatter)
    if (fieldProblem !== null) {
      recordSkillRefusal(file.filePath, fieldProblem, 'legacy-commands')
      continue
    }
    try {
      const fileDir = dirname(file.filePath)
      let base: string
      let namespaceRoot: string
      if (isSkillForm) {
        base = basename(fileDir)
        namespaceRoot = dirname(dirname(file.filePath))
      } else {
        base = basename(file.filePath).replace(/\.md$/i, '')
        namespaceRoot = fileDir
      }
      const namespace = relative(file.baseDir, namespaceRoot).split(sep).filter(Boolean).join(':')
      const name = namespace === '' ? base : `${namespace}:${base}`
      const nameProblem = slashNameProblem(name)
      if (nameProblem !== null) {
        recordSkillRefusal(file.filePath, `uninvocable name: ${nameProblem}`, 'legacy-commands')
        continue
      }
      const fields = parseSkillFrontmatterFields(
        file.frontmatter,
        file.content,
        name,
        COMMAND_FALLBACK_LABEL,
      )
      // Legacy commands cannot rename themselves: the frontmatter display
      // name is discarded so the user-facing name is the computed one.
      fields.displayName = undefined
      const command = createSkillCommand({
        name,
        markdownContent: file.content,
        source: file.source,
        // Only the skill-file form gets a base directory (hence the prefix
        // line and token substitution); a plain .md command gets none.
        baseDir: isSkillForm ? fileDir : undefined,
        loadedFrom: 'legacy-commands',
        fields,
        // Path filters are never parsed for legacy commands.
        pathFilters: undefined,
      })
      out.push({ command, filePath: file.filePath, source: 'legacy-commands' })
    } catch (error) {
      logForDebugging(`legacy commands: failed to load ${file.filePath}: ${errorMessage(error)}`)
    }
  }
  return out
}

async function loadLegacyCommandSkills(cwd: string): Promise<LoadedSkill[]> {
  try {
    const files = await loadMarkdownFilesForSubdir('commands', cwd)
    return transformSkillFiles(files)
  } catch (error) {
    logForDebugging(`legacy commands: walk failed: ${errorMessage(error)}`)
    return []
  }
}

// ── C.5 the merged catalogue ───────────────────────────────────────────────

const pendingConditional = new Map<string, Command>()
const activatedSkillNames = new Set<string>()

async function loadAllSkillsUncached(cwd: string): Promise<Command[]> {
  const userDir = getSkillsPath('userSettings', 'skills')
  const managedDir = getSkillsPath('policySettings', 'skills')
  const projectDirs = getProjectDirsUpToHome('skills', cwd)
  const additionalDirs: string[] = []
  for (const added of getAddedDirectories()) {
    for (const home of PROJECT_CONFIG_DIR_NAMES) {
      additionalDirs.push(join(added, home, 'skills'))
    }
  }
  logForDebugging(
    `skills: managed=${managedDir} user=${userDir} project=[${projectDirs.join(', ')}]`,
  )

  const extensionsOnly = isRestrictedToExtensionsOnly('skills')
  const projectEnabled = isSettingSourceEnabled('projectSettings') && !extensionsOnly

  if (isBareMode()) {
    // Bare mode skips ALL auto-discovery; only explicit --add-dir paths
    // load. Not a policy bypass — the skill lock still applies.
    if (additionalDirs.length === 0 || !projectEnabled) {
      logForDebugging(
        additionalDirs.length === 0
          ? 'skills: bare mode with no added directories — none loaded'
          : 'skills: bare mode and project settings disabled or skill-locked — none loaded',
      )
      return []
    }
    const groups = await Promise.all(
      additionalDirs.map(dir => loadSkillsFromDir(dir, 'projectSettings', 'additional')),
    )
    return splitConditional(groups.flat().map(s => s.command))
  }

  const managedPromise = loadSkillsFromDir(managedDir, 'policySettings', 'managed')
  const userPromise =
    isSettingSourceEnabled('userSettings') && !extensionsOnly
      ? loadSkillsFromDir(userDir, 'userSettings', 'user')
      : Promise.resolve([] as LoadedSkill[])
  const projectPromise = projectEnabled
    ? Promise.all(
        projectDirs.map(dir => loadSkillsFromDir(dir, 'projectSettings', 'project')),
      ).then(groups => groups.flat())
    : Promise.resolve([] as LoadedSkill[])
  const additionalPromise = projectEnabled
    ? Promise.all(
        additionalDirs.map(dir => loadSkillsFromDir(dir, 'projectSettings', 'additional')),
      ).then(groups => groups.flat())
    : Promise.resolve([] as LoadedSkill[])
  const legacyPromise = extensionsOnly
    ? Promise.resolve([] as LoadedSkill[])
    : loadLegacyCommandSkills(cwd)

  const [managed, user, project, additional, legacy] = await Promise.all([
    managedPromise,
    userPromise,
    projectPromise,
    additionalPromise,
    legacyPromise,
  ])
  const ordered = [...managed, ...user, ...project, ...additional, ...legacy]

  // De-duplicate by canonical file identity (realpath, not inode — inodes
  // are unreliable on virtual/container/network/FAT filesystems). First
  // wins; unresolvable identities are kept without de-duplication.
  const identities = await Promise.all(
    ordered.map(async skill => {
      try {
        return await fsPromises.realpath(skill.filePath)
      } catch {
        return null
      }
    }),
  )
  const seen = new Map<string, LoadedSkill>()
  const unique: LoadedSkill[] = []
  let duplicates = 0
  ordered.forEach((skill, index) => {
    const identity = identities[index]
    if (identity === null || identity === undefined) {
      unique.push(skill)
      return
    }
    const winner = seen.get(identity)
    if (winner) {
      duplicates++
      logForDebugging(
        `skills: duplicate ${skill.command.name} from ${skill.source} skipped — already loaded from ${winner.source}`,
      )
      return
    }
    seen.set(identity, skill)
    unique.push(skill)
  })
  if (duplicates > 0) logForDebugging(`skills: removed ${duplicates} duplicate(s)`)

  const commands = unique.map(s => s.command)
  const perSource = new Map<string, number>()
  for (const skill of unique) {
    perSource.set(skill.source, (perSource.get(skill.source) ?? 0) + 1)
  }
  const result = splitConditional(commands)
  logForDebugging(
    `skills: ${commands.length} unique — ${result.length} unconditional, ${commands.length - result.length} conditional (${[...perSource].map(([k, v]) => `${k}=${v}`).join(' ')})`,
  )
  return result
}

/** Withhold not-yet-activated conditional skills into the pending map. */
function splitConditional(commands: Command[]): Command[] {
  const unconditional: Command[] = []
  let withheld = 0
  for (const command of commands) {
    const filters = (command as { pathFilters?: string[] }).pathFilters
    if (filters && filters.length > 0 && !activatedSkillNames.has(command.name)) {
      pendingConditional.set(command.name, command)
      withheld++
      continue
    }
    unconditional.push(command)
  }
  if (withheld > 0) logForDebugging(`skills: withheld ${withheld} conditional skill(s)`)
  return unconditional
}

const loadAllSkillsMemo = memoize(loadAllSkillsUncached)

/** The merged catalogue, memoised per cwd. */
export function getSkillDirCommands(cwd: string): Promise<Command[]> {
  return loadAllSkillsMemo(cwd)
}

export function clearSkillCaches(): void {
  loadAllSkillsMemo.cache.clear?.()
  clearMarkdownFileCache()
  pendingConditional.clear()
  activatedSkillNames.clear()
  skillLoadRefusals.clear()
  // An already-activated skill stays available across this clear through
  // the dynamic map (check 31) — only the withholding bookkeeping resets.
  // The dynamic map is PRUNED, never wiped: a skill whose SKILL.md is gone
  // leaves the table now; loaded directories re-validate on their next
  // touch (FN-015 rank 29).
  pruneDynamicSkillsSync()
}

// Backwards-compatible aliases.
export const getCommandDirCommands = getSkillDirCommands
export const clearCommandCaches = clearSkillCaches

// ── C.6 dynamic discovery and conditional activation ───────────────────────

/** One dynamic skill as loaded: the command, its SKILL.md and the mtime the
 *  body was read at — the liveness record (FN-015 rank 29). */
type DynamicSkillEntry = { name: string; filePath: string; mtimeMs: number; command: Command }
/** What a probe learned about `<dir>/<home>/skills`: absent (or refused),
 *  re-probed after the horizon; or loaded — `seen` is every SKILL.md the
 *  directory held at load time (refused ones included, so a broken skill
 *  does not read as a change every time), re-validated after the horizon
 *  and at once when a touch lands inside the directory. */
type DynamicDirRecord =
  | { state: 'missing'; examinedAt: number }
  | { state: 'loaded'; examinedAt: number; entries: DynamicSkillEntry[]; seen: Array<{ name: string; mtimeMs: number }> }

const dynamicSkills = new Map<string, Command>()
const examinedCandidates = new Map<string, DynamicDirRecord>()
const skillsLoadedSignal = createSignal()

/** The probe cache's horizon. Before it existed a candidate absent at its
 *  first probe was negatively cached for the process (the add ran before
 *  the stat), so a nested skill created mid-session never applied; a loaded
 *  directory was never re-read, so an edit kept the boot-time body and a
 *  deletion stayed invocable. */
const DYNAMIC_PROBE_TTL_MS = 30_000
let dynamicProbeTtlMs = DYNAMIC_PROBE_TTL_MS

/** Proof seam: tighten the horizon so a prover need not wait it out. */
export function setDynamicSkillProbeTtlForProofs(ms: number | null): void {
  dynamicProbeTtlMs = ms ?? DYNAMIC_PROBE_TTL_MS
}

export function onDynamicSkillsLoaded(callback: () => void): () => void {
  return skillsLoadedSignal.subscribe(() => {
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
}

function dynamicSkillsRefused(): boolean {
  if (!isSettingSourceEnabled('projectSettings') || isRestrictedToExtensionsOnly('skills')) {
    logForDebugging('skills: dynamic directories refused (project settings disabled or extensions-only policy)')
    return true
  }
  return false
}

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await fsPromises.stat(filePath)).mtimeMs
  } catch {
    return null
  }
}

/** Every SKILL.md the directory holds right now, by skill name and mtime. */
async function listSkillFiles(dir: string): Promise<Array<{ name: string; mtimeMs: number }> | null> {
  let names: string[]
  try {
    names = (await fsPromises.readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
  } catch {
    return null
  }
  const seen: Array<{ name: string; mtimeMs: number }> = []
  for (const name of names) {
    const mtimeMs = await mtimeOf(join(dir, name, SKILL_FILE_NAME))
    if (mtimeMs !== null) seen.push({ name, mtimeMs })
  }
  return seen
}

/** True when the directory's SKILL.md set differs from the record: a file
 *  gone, a file added, or a body rewritten (mtime). A vanished directory
 *  is a change too. */
async function dynamicDirChanged(dir: string, record: Extract<DynamicDirRecord, { state: 'loaded' }>): Promise<boolean> {
  const seen = await listSkillFiles(dir)
  if (seen === null) return true
  if (seen.length !== record.seen.length) return true
  for (const was of record.seen) {
    const now = seen.find(entry => entry.name === was.name)
    if (now === undefined || now.mtimeMs !== was.mtimeMs) return true
  }
  return false
}

async function loadDynamicDir(dir: string): Promise<{ entries: DynamicSkillEntry[]; seen: Array<{ name: string; mtimeMs: number }> | null }> {
  const seen = await listSkillFiles(dir)
  const loaded = seen === null ? [] : await loadSkillsFromDir(dir, 'projectSettings', 'dynamic')
  const entries: DynamicSkillEntry[] = loaded.map(skill => ({
    name: skill.command.name,
    filePath: skill.filePath,
    mtimeMs: seen?.find(entry => entry.name === skill.command.name)?.mtimeMs ?? 0,
    command: skill.command,
  }))
  return { entries, seen }
}

/** Seat a directory's freshly loaded set: the names it owned and no longer
 *  provides leave the map (identity-guarded — a shallower directory's
 *  same-named skill is never evicted by mistake), the new commands enter,
 *  the record turns over. True when the map changed. */
function applyDynamicDir(
  dir: string,
  entries: DynamicSkillEntry[],
  seen: Array<{ name: string; mtimeMs: number }> | null,
  now: number,
): boolean {
  const previous = examinedCandidates.get(dir)
  let changed = false
  if (previous?.state === 'loaded') {
    for (const old of previous.entries) {
      if (dynamicSkills.get(old.name) === old.command && !entries.some(entry => entry.name === old.name)) {
        dynamicSkills.delete(old.name)
        changed = true
      }
    }
  }
  for (const entry of entries) {
    if (dynamicSkills.get(entry.name) !== entry.command) {
      dynamicSkills.set(entry.name, entry.command)
      changed = true
    }
  }
  // A directory that vanished is absent again: its rebirth is a discovery.
  examinedCandidates.set(dir, seen === null ? { state: 'missing', examinedAt: now } : { state: 'loaded', examinedAt: now, entries, seen })
  return changed
}

/** Re-read loaded directories whose SKILL.md set moved (deepest first, so
 *  the shallowest seats first and deeper ones win name collisions). */
async function reloadDynamicDirs(dirs: string[]): Promise<void> {
  if (dirs.length === 0 || dynamicSkillsRefused()) return
  const now = Date.now()
  const loaded = await Promise.all(dirs.map(async dir => ({ dir, ...(await loadDynamicDir(dir)) })))
  let changed = false
  for (let i = loaded.length - 1; i >= 0; i--) {
    const { dir, entries, seen } = loaded[i] as (typeof loaded)[number]
    if (applyDynamicDir(dir, entries, seen, now)) changed = true
  }
  if (changed) {
    logForDebugging(`skills: ${dirs.length} dynamic directorie(s) re-read after a change on disk`)
    skillsLoadedSignal.emit()
  }
}

/** The synchronous prune the catalogue clear runs: a dynamic skill whose
 *  SKILL.md is gone leaves the map now, and every loaded directory is
 *  marked for re-validation on its next touch. Never a wipe (check 31). */
function pruneDynamicSkillsSync(): void {
  let changed = false
  for (const [dir, record] of examinedCandidates) {
    if (record.state !== 'loaded') continue
    const survivors = record.entries.filter(entry => {
      if (existsSync(entry.filePath)) return true
      if (dynamicSkills.get(entry.name) === entry.command) {
        dynamicSkills.delete(entry.name)
        changed = true
      }
      return false
    })
    examinedCandidates.set(dir, {
      state: 'loaded',
      examinedAt: 0,
      entries: survivors,
      seen: record.seen.filter(was => survivors.some(entry => entry.name === was.name)),
    })
  }
  if (changed) skillsLoadedSignal.emit()
}

/**
 * Walk each touched file's ancestry strictly BELOW cwd (prefix-plus-
 * separator — a sibling whose name merely begins with the cwd string must
 * not match), probing `<dir>/<home>/skills` with negative caching that
 * expires, git-ignore filtered (fail-open outside a repository). A loaded
 * directory is re-validated after the horizon — and at once when the touch
 * lies inside it — and re-read in place when its SKILL.md set moved.
 * Returns newly discovered directories DEEPEST FIRST.
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const discovered: string[] = []
  const stale: string[] = []
  const now = Date.now()
  const cwdPrefix = cwd.endsWith(sep) ? cwd : cwd + sep
  for (const filePath of filePaths) {
    const touched = resolve(cwd, filePath)
    let dir = dirname(touched)
    while (dir.startsWith(cwdPrefix) && dir !== cwd) {
      for (const home of PROJECT_CONFIG_DIR_NAMES) {
        const candidate = join(dir, home, 'skills')
        // Announced earlier in this same walk: the caller loads it once.
        if (discovered.includes(candidate)) continue
        const record = examinedCandidates.get(candidate)
        // The touch is evidence: a path inside the candidate re-probes it now.
        const inside = touched.startsWith(candidate + sep)
        if (record !== undefined && !inside && now - record.examinedAt < dynamicProbeTtlMs) continue
        if (record?.state === 'loaded') {
          if (await dynamicDirChanged(candidate, record)) {
            if (!stale.includes(candidate)) stale.push(candidate)
          } else {
            record.examinedAt = now
          }
          continue
        }
        try {
          const stat = await fsPromises.stat(candidate)
          if (!stat.isDirectory()) {
            examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
            continue
          }
        } catch {
          examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
          continue
        }
        // The invocation-time trust dialog is the real boundary; this is a
        // hygiene filter blocking e.g. vendored dependency skills. Re-probed
        // after the horizon: an ignore rule can change.
        if (await isPathGitignored(dir, cwd)) {
          logForDebugging(`skills: ${candidate} skipped (containing directory is git-ignored)`)
          examinedCandidates.set(candidate, { state: 'missing', examinedAt: now })
          continue
        }
        // Provisionally loaded (no entries yet): a caller that never loads
        // it re-validates after the horizon and reads it then.
        examinedCandidates.set(candidate, { state: 'loaded', examinedAt: now, entries: [], seen: [] })
        discovered.push(candidate)
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  await reloadDynamicDirs(stale.sort((a, b) => b.length - a.length))
  return discovered.sort((a, b) => b.length - a.length)
}

/** Load discovered directories (expected deepest-first) into the dynamic
 *  map; shallowest merges first so deeper ones win name collisions. */
export async function addSkillDirectories(dirs: string[]): Promise<void> {
  if (dynamicSkillsRefused()) return
  if (dirs.length === 0) return
  const now = Date.now()
  const loaded = await Promise.all(dirs.map(async dir => ({ dir, ...(await loadDynamicDir(dir)) })))
  let changed = false
  let count = 0
  for (let i = loaded.length - 1; i >= 0; i--) {
    const { dir, entries, seen } = loaded[i] as (typeof loaded)[number]
    if (applyDynamicDir(dir, entries, seen, now)) changed = true
    count += entries.length
  }
  if (count > 0) logForDebugging(`skills: ${count} dynamic skill(s) from ${dirs.length} directorie(s)`)
  if (changed) skillsLoadedSignal.emit()
}

export function getDynamicSkills(): Command[] {
  return [...dynamicSkills.values()]
}

/**
 * Activate pending conditional skills whose path filters match a touched
 * file. Gitignore-style matching, cwd-relative; paths that relativise
 * empty, escape the base, or stay absolute are skipped.
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (pendingConditional.size === 0) return []
  const activated: string[] = []
  for (const [name, command] of pendingConditional) {
    const filters = (command as { pathFilters?: string[] }).pathFilters ?? []
    if (filters.length === 0) continue
    const matcher = ignore().add(filters)
    for (const filePath of filePaths) {
      const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
      if (matcher.ignores(rel)) {
        dynamicSkills.set(name, command)
        pendingConditional.delete(name)
        activatedSkillNames.add(name)
        activated.push(name)
        logForDebugging(`skills: conditional skill ${name} activated by ${rel}`)
        break
      }
    }
  }
  if (activated.length > 0) skillsLoadedSignal.emit()
  return activated
}

export function getConditionalSkillCount(): number {
  return pendingConditional.size
}

export function clearDynamicSkills(): void {
  dynamicSkills.clear()
  examinedCandidates.clear()
  pendingConditional.clear()
  activatedSkillNames.clear()
}
