import { readLocationSourceLines, type Locationish } from '../formatters.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type LspRangeLike } from '../../../services/lsp/workspaceEditApply.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, isMethodNotFoundError, syncFileFromDisk } from './shared.js'

export async function opTypeDefinition(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  type Location = { uri?: string; targetUri?: string; range?: LspRangeLike; targetRange?: LspRangeLike; targetSelectionRange?: LspRangeLike }
  let response: Location | Location[] | null | undefined
  try {
    response = await env.manager.sendRequest<Location | Location[] | null>(
      env.absolutePath,
      'textDocument/typeDefinition',
      {
        textDocument: { uri },
        position: { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 },
      },
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return {
        result: `The language server for ${display} does not support typeDefinition.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'typeDefinition unsupported',
        },
      }
    }
    throw error
  }
  const list: Location[] =
    response === null || response === undefined
      ? []
      : Array.isArray(response)
        ? response
        : [response]
  if (list.length === 0) {
    return {
      result: `No type definition found at ${display}:${input.line ?? 1}:${input.character ?? 1}.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no type definition (a real answer)',
      },
    }
  }
  const rows: string[] = []
  const displays = new Set<string>()
  const sourceLines = await readLocationSourceLines(list as Locationish[], env.tool, env.context)
  let total = 0
  for (const location of list) {
    const locationUri = location.targetUri ?? location.uri
    if (locationUri === undefined) continue
    const range = location.targetSelectionRange ?? location.targetRange ?? location.range
    const locationDisplay = displayPathFor(env.cwd, locationUri)
    displays.add(locationDisplay)
    const line = (range?.start.line ?? 0) + 1
    const character = (range?.start.character ?? 0) + 1
    total++
    if (total <= 50) {
      rows.push(`  ${locationDisplay}:${line}:${character}`)
      const source = sourceLines.get(location as Locationish)
      if (source) rows.push(`    ${source}`)
    }
  }
  if (total > 50) rows.push(`${total - 50} more type definitions.`)
  return {
    result: `${total} type definition(s):\n${rows.join('\n')}`,
    resultCount: total,
    fileCount: displays.size,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${total} location(s)`,
    },
  }
}
