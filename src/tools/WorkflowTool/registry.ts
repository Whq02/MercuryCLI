// =============================================================================
// The workflow name registry.
//
// Resolves a workflow NAME — as used by Workflow({name}), the inline
// workflow() DSL hook, and the per-workflow slash commands — against three
// sources, with a fixed precedence on a name collision:
//
//   1. user + project workflow directories   (highest)
//   3. the built-in registry                 (lowest)
//
// The built-in set begins empty; the bundled registration (bundled/index.ts)
// fills it during startup. Local directories are re-read on every listing so
// an edit shows up without restarting; the built-in list is fixed per
// process. This module also owns the boards' save action: turning a run's
// persisted script into a named project workflow, with saves that never
// overwrite one another.
// =============================================================================

import { workflowsDir } from './runManifest.js'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getProjectDirsUpToHome } from '../../utils/markdownConfigLoader.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { parseWorkflowScript } from './compiler.js'
import type { ParsedWorkflow, WorkflowMeta } from './compiler.js'
import { MAX_SCRIPT_BYTES } from './workflowConstants.js'
import { workflowsDisabled } from './workflowEnablement.js'

// -----------------------------------------------------------------------------
// The descriptor every consumer reads (the tool, the injected resolvers, the
// command factory, the boards).
// -----------------------------------------------------------------------------
export interface WorkflowDescriptor {
  /** Which registry produced the entry — collision precedence hangs on it. */
  source: 'built-in' | 'userSettings' | 'projectSettings'
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowMeta['phases']
  /** The full script text, meta export included. */
  script: string
  filePath?: string
  /** Hidden entries resolve by name but stay out of listings. */
  hidden?: boolean
}

// parseWorkflowScript signals failure WITH an `ok` key and success WITHOUT one.
function isParsed(p: ParsedWorkflow | { ok: false; error: string }): p is ParsedWorkflow {
  return !('ok' in p)
}

// =============================================================================
// Built-in registry.
// =============================================================================

// Populated at startup by the bundled-workflow registration — never at load.
const builtinRegistry: WorkflowDescriptor[] = []

/** Register one built-in workflow (startup-time, idempotence owned by the
 *  caller). Hidden built-ins exist for skill-launched workflows that should
 *  not appear in listings. */
export function registerBuiltinWorkflow(
  script: string,
  meta: Omit<WorkflowDescriptor, 'source' | 'script' | 'hidden'>,
  opts?: { hidden?: boolean },
): void {
  // Spread order is deliberate: script/hidden always win over meta extras.
  builtinRegistry.push({ source: 'built-in', ...meta, script, hidden: opts?.hidden })
}

/** The built-in list — empty whenever workflows are disabled. */
export function getBuiltinWorkflows(): WorkflowDescriptor[] {
  if (workflowsDisabled()) return []
  return builtinRegistry
}

// =============================================================================
// Directory loading.
// =============================================================================

/**
 * Load every `*.js` workflow in one directory. Oversized files and files with
 * invalid meta are skipped with a debug warning; a missing/unreadable
 * directory yields an empty list. Never throws — one bad file must not take
 * down a listing. Symlinked entries load like regular files.
 */
async function readWorkflowDir(
  dir: string,
  source: WorkflowDescriptor['source'],
): Promise<WorkflowDescriptor[]> {
  const fs = getFsImplementation()
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const loaded = await Promise.all(
    entries.map(async (entry): Promise<WorkflowDescriptor | null> => {
      if (!(entry.isFile() || entry.isSymbolicLink())) return null
      if (!entry.name.endsWith('.js')) return null
      const filePath = join(dir, entry.name)
      let bytes: Buffer
      try {
        // One byte past the cap is enough to detect "too big" without
        // reading an arbitrarily large file into memory.
        bytes = await fs.readFileBytes(filePath, MAX_SCRIPT_BYTES + 1)
      } catch {
        return null
      }
      if (bytes.byteLength > MAX_SCRIPT_BYTES) {
        logForDebugging(
          `Workflow ${filePath} exceeds ${MAX_SCRIPT_BYTES} bytes — skipping`,
          { level: 'warn' },
        )
        return null
      }
      const script = bytes.toString('utf-8')
      const parsed = parseWorkflowScript(script)
      if (!isParsed(parsed)) {
        logForDebugging(
          `Workflow ${filePath} has invalid meta: ${parsed.error} — skipping`,
          { level: 'warn' },
        )
        return null
      }
      return {
        source,
        name: parsed.meta.name,
        description: parsed.meta.description,
        whenToUse: parsed.meta.whenToUse,
        phases: parsed.meta.phases,
        script,
        filePath,
      }
    }),
  )
  return loaded.filter((w): w is WorkflowDescriptor => w !== null)
}

/**
 * Merge the user workflows directory with every project workflows directory
 * between cwd and the repository root, honouring each source's settings-scope
 * switch. Collisions resolve toward specificity: the closest project
 * directory beats farther ones, and any project entry beats the user entry.
 * One entry per name, alphabetical.
 */
async function collectLocalWorkflows(cwd: string): Promise<WorkflowDescriptor[]> {
  const userAllowed = isSettingSourceEnabled('userSettings')
  const projectAllowed = isSettingSourceEnabled('projectSettings')
  const userDir = join(getMercuryHome(), 'workflows')
  // Existing workflow dirs only, ordered most-specific (cwd) first.
  const projectDirs = getProjectDirsUpToHome('workflows', cwd)

  const [userEntries, projectLists] = await Promise.all([
    userAllowed ? readWorkflowDir(userDir, 'userSettings') : Promise.resolve<WorkflowDescriptor[]>([]),
    projectAllowed
      ? Promise.all(projectDirs.map(dir => readWorkflowDir(dir, 'projectSettings')))
      : Promise.resolve<WorkflowDescriptor[][]>([]),
  ])

  // Overwrite upward in precedence: the user entries first, then the project
  // directories from the farthest in, so the most-specific one writes last —
  // and therefore wins the name.
  const byName = new Map<string, WorkflowDescriptor>()
  for (const entry of userEntries) byName.set(entry.name, entry)
  for (let i = projectLists.length - 1; i >= 0; i--) {
    for (const entry of projectLists[i] ?? []) byName.set(entry.name, entry)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// =============================================================================
// Resolvers.
// =============================================================================

/**
 * Every workflow visible from `cwd`, one entry per name. Precedence when a
 * name appears in both sources: local directories first, then built-ins.
 * The disabled path short-circuits to the built-in list (empty in that
 * state). Concatenation order — built-ins, local — shows through in
 * listings and in the "Available:" text of not-found errors, so it is part
 * of the contract.
 */
export async function listWorkflows(cwd: string): Promise<WorkflowDescriptor[]> {
  if (workflowsDisabled()) return [...getBuiltinWorkflows()]

  const userProject = await collectLocalWorkflows(cwd)
  const userProjectNames = new Set(userProject.map(w => w.name))
  const builtinFiltered = getBuiltinWorkflows().filter(w => !userProjectNames.has(w.name))

  return [...builtinFiltered, ...userProject]
}

/** Alias for the executor's injected getAllWorkflows slot. */
export const getAllWorkflows = listWorkflows

/** Resolve a single workflow by exact name. */
export async function resolveWorkflowName(
  name: string,
  cwd: string,
): Promise<WorkflowDescriptor | undefined> {
  const all = await listWorkflows(cwd)
  return all.find(w => w.name === name)
}

/** Secondary spelling kept for callers that reach for the verb-first name. */
export const resolveWorkflowByName = resolveWorkflowName

// -----------------------------------------------------------------------------
// Saving a run's script as a named project workflow (the boards' save action).
// Honest collisions: identical content reports already-saved; different
// content gets a numbered sibling — an existing save is never clobbered.
// -----------------------------------------------------------------------------
export type SaveWorkflowResult =
  | { ok: true; savedPath: string; already?: boolean }
  | { ok: false; error: string }

/** Save in-memory script source under the project workflows directory as
 *  `<slug>.js` (or the first free numbered sibling). */
export async function saveWorkflowSourceToProject(opts: {
  source: string
  /** Preferred name (usually the run's workflow name); sanitized to a slug. */
  name?: string
  cwd: string
}): Promise<SaveWorkflowResult> {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises')
  const slug =
    (opts.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'workflow'
  const dir = workflowsDir(opts.cwd)
  try {
    await mkdir(dir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}` }
  }
  // Slot sequence: <slug>.js, then -2 through -9 suffixes. Finding identical
  // content in any slot means this exact script is already saved; otherwise
  // the first vacancy takes the write.
  for (let n = 1; n <= 9; n++) {
    const target = join(dir, n === 1 ? `${slug}.js` : `${slug}-${n}.js`)
    let existing: string | undefined
    try {
      existing = await readFile(target, 'utf8')
    } catch {
      existing = undefined
    }
    if (existing === opts.source) return { ok: true, savedPath: target, already: true }
    if (existing === undefined) {
      try {
        // Exclusive create closes the race between the miss above and this
        // write — two simultaneous saves under one slug must both survive,
        // one landing here and the other advancing to the next slot on
        // EEXIST.
        await writeFile(target, opts.source, { encoding: 'utf8', flag: 'wx' })
        return { ok: true, savedPath: target }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }
  return { ok: false, error: `too many saved variants of "${slug}" — clean ${dir}` }
}

/** Save a persisted run script (by path) as a named project workflow. */
export async function saveWorkflowToProject(opts: {
  scriptPath: string
  name?: string
  cwd: string
}): Promise<SaveWorkflowResult> {
  const { readFile } = await import('node:fs/promises')
  let source: string
  try {
    source = await readFile(opts.scriptPath, 'utf8')
  } catch {
    return { ok: false, error: `script not readable: ${opts.scriptPath}` }
  }
  return saveWorkflowSourceToProject({ source, name: opts.name, cwd: opts.cwd })
}
