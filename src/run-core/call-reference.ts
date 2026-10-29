import { createHash } from 'node:crypto'

export type ModelCallReference = {
  v: 1
  model: string
  effortRequested: string | undefined
  maxOutputTokensOverride: number | undefined
  toolCount: number
  toolNames: readonly string[]
  toolPlanDigest: string
  digest: string
}

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data).digest('hex')

export function buildModelCallReference(args: {
  model: string
  effort: string | number | undefined
  maxOutputTokensOverride: number | undefined
  tools: ReadonlyArray<{ name: string }>
}): ModelCallReference {
  const effortRequested =
    args.effort === undefined ? undefined : String(args.effort)
  const toolNames = Object.freeze(args.tools.map(t => t.name))
  const toolPlanDigest = sha256Hex(
    JSON.stringify({ v: 1, tools: toolNames }),
  )
  const digest = sha256Hex(
    JSON.stringify({
      v: 1,
      model: args.model,
      effort: effortRequested ?? null,
      maxOut: args.maxOutputTokensOverride ?? null,
      tools: toolNames,
    }),
  )
  return Object.freeze({
    v: 1,
    model: args.model,
    effortRequested,
    maxOutputTokensOverride: args.maxOutputTokensOverride,
    toolCount: toolNames.length,
    toolNames,
    toolPlanDigest,
    digest,
  })
}
