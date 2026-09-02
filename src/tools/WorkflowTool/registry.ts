
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

export interface WorkflowDescriptor {
  source: 'built-in' | 'userSettings' | 'projectSettings'
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowMeta['phases']
  script: string
  filePath?: string
  hidden?: boolean
}

function isParsed(p: ParsedWorkflow | { ok: false; error: string }): p is ParsedWorkflow {
  return !('ok' in p)
}


const builtinRegistry: WorkflowDescriptor[] = []

export function registerBuiltinWorkflow(
  script: string,
  meta: Omit<WorkflowDescriptor, 'source' | 'script' | 'hidden'>,
  opts?: { hidden?: boolean },
): void {
  builtinRegistry.push({ source: 'built-in', ...meta, script, hidden: opts?.hidden })
}

export function getBuiltinWorkflows(): WorkflowDescriptor[] {
  if (workflowsDisabled()) return []
  return builtinRegistry
}


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

async function collectLocalWorkflows(cwd: string): Promise<WorkflowDescriptor[]> {
  const userAllowed = isSettingSourceEnabled('userSettings')
  const projectAllowed = isSettingSourceEnabled('projectSettings')
  const userDir = join(getMercuryHome(), 'workflows')
  const projectDirs = getProjectDirsUpToHome('workflows', cwd)

  const [userEntries, projectLists] = await Promise.all([
    userAllowed ? readWorkflowDir(userDir, 'userSettings') : Promise.resolve<WorkflowDescriptor[]>([]),
    projectAllowed
      ? Promise.all(projectDirs.map(dir => readWorkflowDir(dir, 'projectSettings')))
      : Promise.resolve<WorkflowDescriptor[][]>([]),
  ])

  const byName = new Map<string, WorkflowDescriptor>()
  for (const entry of userEntries) byName.set(entry.name, entry)
  for (let i = projectLists.length - 1; i >= 0; i--) {
    for (const entry of projectLists[i] ?? []) byName.set(entry.name, entry)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}


export async function listWorkflows(cwd: string): Promise<WorkflowDescriptor[]> {
  if (workflowsDisabled()) return [...getBuiltinWorkflows()]

  const userProject = await collectLocalWorkflows(cwd)
  const userProjectNames = new Set(userProject.map(w => w.name))
  const builtinFiltered = getBuiltinWorkflows().filter(w => !userProjectNames.has(w.name))

  return [...builtinFiltered, ...userProject]
}

export const getAllWorkflows = listWorkflows

export async function resolveWorkflowName(
  name: string,
  cwd: string,
): Promise<WorkflowDescriptor | undefined> {
  const all = await listWorkflows(cwd)
  return all.find(w => w.name === name)
}

export const resolveWorkflowByName = resolveWorkflowName

export type SaveWorkflowResult =
  | { ok: true; savedPath: string; already?: boolean }
  | { ok: false; error: string }

export async function saveWorkflowSourceToProject(opts: {
  source: string
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
