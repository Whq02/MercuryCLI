import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { collapseWhitespace, stripTerminalControls } from '../../utils/stringUtils.js'
import { MEDIA_SERVER_NAME, readMediaSettings } from './settings.js'
import { mediaHostLocation } from './host.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../../utils/projectConfig.js'

const pipelineIdentity = z.object({ name: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().optional() }).passthrough()
const stepRecord = z.object({
  id: z.string().min(1), kind: z.string(), status: z.enum(['completed', 'reused', 'failed', 'cancelled']),
  model: z.string().nullable(), seed: z.number().nullable(),
  outputs: z.object({ image: z.string(), images: z.array(z.string()) }).passthrough().optional(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() }).passthrough()).optional(),
  error: z.string().optional(),
}).passthrough()
const runRecord = z.object({
  version: z.literal(1), runId: z.string().min(1), pipeline: pipelineIdentity,
  pipelineHash: z.string().regex(/^[a-f0-9]{64}$/), document: z.unknown(),
  status: z.string(), fromStep: z.string().optional(), steps: z.array(stepRecord), outputs: z.array(z.string()), remote: z.string().optional(),
}).passthrough()
export type MediaPipelineRunRecord = z.infer<typeof runRecord>

export function isMediaPipelineTool(serverName: string, toolName: string): boolean {
  return serverName === MEDIA_SERVER_NAME && ['pipeline_validate', 'pipeline_describe', 'pipeline_run', 'pipeline_import_workflow', 'pipeline_export_workflow'].includes(toolName)
}

export async function discoverMediaPipelines(cwd: string): Promise<string[]> {
  const paths: string[] = []
  const pending = [resolve(cwd)]
  while (pending.length) {
    const dir = pending.pop()!
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && !['.git', 'node_modules', ...PROJECT_CONFIG_DIR_NAMES].includes(entry.name)) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.pipeline.json')) paths.push(path)
    }
  }
  return paths.sort()
}

export function mediaPipelineDetail(name: string, step: string): string {
  return collapseWhitespace(stripTerminalControls(`Pipeline: ${name} · step ${step}`))
}

export async function readMediaPipelineFile(path: string, cwd: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(cwd, path), 'utf8')) as unknown
}

export async function readMediaPipelineRunRecord(path: string, cwd: string): Promise<MediaPipelineRunRecord> {
  return runRecord.parse(await readMediaPipelineFile(path, cwd))
}

export async function readMediaPipelineDetails(input: Record<string, unknown>, cwd: string): Promise<string> {
  const project = typeof input.cwd === 'string' ? resolve(cwd, input.cwd) : cwd
  const document = z.object({ name: z.string().min(1), steps: z.array(z.object({ id: z.string().min(1) })).min(1) }).parse(
    typeof input.pipeline === 'string' ? await readMediaPipelineFile(input.pipeline, project) : input.pipeline,
  )
  const step = typeof input.step === 'string' ? input.step : document.steps[0]!.id
  if (!document.steps.some(row => row.id === step)) throw new Error(`Pipeline step ${step} does not exist.`)
  if (typeof input.resume === 'string') await readMediaPipelineRunRecord(input.resume, project)
  return [mediaHostLocation(readMediaSettings()), mediaPipelineDetail(document.name, step), `Output: ${join(project, 'media')}`].filter(Boolean).join('\n')
}

export function mediaPipelineArguments(serverName: string, toolName: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  if (!isMediaPipelineTool(serverName, toolName)) return input
  return { ...input, cwd: input.cwd === undefined ? cwd : typeof input.cwd === 'string' ? resolve(cwd, input.cwd) : input.cwd }
}

export async function mediaPipelineDiscoveryContent(serverName: string, toolName: string, input: Record<string, unknown>, cwd: string): Promise<Array<{ type: 'text'; text: string }>> {
  if (serverName !== MEDIA_SERVER_NAME || toolName !== 'pipeline_describe' || input.pipeline !== undefined || (input.cwd !== undefined && typeof input.cwd !== 'string')) return []
  const project = typeof input.cwd === 'string' ? resolve(cwd, input.cwd) : cwd
  return [{ type: 'text', text: JSON.stringify({ pipelines: await discoverMediaPipelines(project) }) }]
}
