import type { ApiShapedTool } from '../zai/zaiCodec.js'

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function referenceFault(schema: unknown, root: unknown, seen: Set<unknown>): string | undefined {
  const node = record(schema)
  if (!node || seen.has(node)) return undefined
  seen.add(node)
  if ('$ref' in node) {
    const ref = node.$ref
    if (typeof ref !== 'string') return '$ref must be a string'
    if (!ref.startsWith('#/')) return `unsupported $ref ${ref}; only references into the same schema are supported`
    let target = root
    for (const key of ref.slice(2).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if ((typeof target !== 'object' || target === null) || !Object.hasOwn(target, key)) return `unresolved $ref ${ref}`
      target = (target as Record<string, unknown>)[key]
    }
    return referenceFault(target, root, seen)
  }
  const alternatives = node.oneOf ?? node.anyOf
  const children = Array.isArray(alternatives) ? alternatives : [
    ...Object.values(record(node.properties) ?? {}),
    node.items, node.additionalProperties,
    ...(Array.isArray(node.allOf) ? node.allOf : []),
  ]
  for (const child of children) {
    const fault = referenceFault(child, root, seen)
    if (fault) return fault
  }
  return undefined
}

export function compatToolSchemaRefusal(dialect: string | undefined, tool: ApiShapedTool): string | undefined {
  if (dialect !== 'llamacpp') return undefined
  const fault = referenceFault(tool.input_schema, tool.input_schema, new Set())
  return fault ? `llama.cpp cannot take the ${tool.name} tool’s schema: ${fault} — the request was not sent and no tools were removed; update its schema before retrying` : undefined
}
