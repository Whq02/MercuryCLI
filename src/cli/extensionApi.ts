import { z } from 'zod/v4'
import { computeRequests, externalCompute, type ComputeDeps } from '../services/extensions/compute.js'
import { bankRequests, externalBank } from '../services/extensions/bank.js'

export const extensionRequest = z.discriminatedUnion('op', [
  z.strictObject({ version: z.literal(1), op: z.literal('context'), project: z.string().min(1) }),
  z.strictObject({ version: z.literal(1), op: z.literal('redact'), value: z.json() }),
  z.strictObject({ version: z.literal(1), op: z.literal('complete'), model: z.string().min(1), system: z.string(), prompt: z.string().min(1) }),
  ...computeRequests,
  ...bankRequests,
])
export async function extensionApi(input: unknown, signal: AbortSignal, compute: ComputeDeps = {}): Promise<unknown> {
  const request = extensionRequest.parse(input)
  if (request.op === 'context') {
    const [{ getProjectDir }, { getAllBaseTools }, { zodToJsonSchema }, { HOST_RECIPES, LLAMACPP_ENGINE_SHA }] = await Promise.all([import('../utils/sessionStoragePortable.js'), import('../tools.js'), import('../utils/zodToJsonSchema.js'), import('../services/host/recipes.js')])
    const tools = getAllBaseTools().map(tool => ({ type: 'function', function: { name: tool.name, ...(tool.searchHint ? { description: tool.searchHint } : {}), parameters: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema) } }))
    return { projectDir: getProjectDir(request.project), tools, engine: { revision: LLAMACPP_ENGINE_SHA, recipe: HOST_RECIPES.find(row => row.engine === 'llamacpp') } }
  }
  if (request.op === 'redact') {
    const { sessionSecretValues, createSecretRedactor } = await import('../utils/redactSecrets.js')
    const redact = createSecretRedactor(await sessionSecretValues())
    const walk = (value: unknown): unknown => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), walk(item)])) : value
    return { value: walk(request.value) }
  }
  if (request.op === 'complete') return (await import('../services/extensions/complete.js')).completeExternal({ ...request, signal })
  if (request.op === 'bank.plan' || request.op === 'bank.register') return externalBank(request, signal)
  return externalCompute(request, signal, compute)
}
export async function extensionApiCli(options: { json?: boolean }): Promise<number> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    if (!options.json) throw new Error('Use extension-api --json with one JSON request on stdin')
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const result = await extensionApi(JSON.parse(Buffer.concat(chunks).toString('utf8')), controller.signal)
    process.stdout.write(JSON.stringify({ version: 1, ok: true, result }) + '\n')
    return 0
  } catch (error) {
    process.stdout.write(JSON.stringify({ version: 1, ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n')
    return 1
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}
