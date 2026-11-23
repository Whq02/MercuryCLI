import type * as TS from 'typescript'
import { type LspLocation, spanToRange, toUri, symbolKindOf } from '../lsp.js'
import { spansToLocations, navTreeToSymbols } from '../convert.js'
import type { DocContext, RequireState } from '../needs.js'
import { logForDebugging } from '../../../../../platform/logs/debugLog.js'
import { passedOver } from '../../../../../platform/errors/passedOver.js'

export function definitionRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const info = project.service.getDefinitionAndBoundSpan(file, offset)
  return spansToLocations(st, info?.definitions ?? [])
}

export function implementationRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const impls = project.service.getImplementationAtPosition(
    file,
    offset,
  )
  return spansToLocations(st, impls ?? [])
}

export function typeDefinitionRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const defs = project.service.getTypeDefinitionAtPosition(
    file,
    offset,
  )
  return spansToLocations(st, defs ?? [])
}

export function referencesRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const p = params as { context?: { includeDeclaration?: boolean } }
  const includeDecl = p.context?.includeDeclaration !== false
  const refs = project.service.getReferencesAtPosition(file, offset)
  const filtered = (refs ?? []).filter(
    r => includeDecl || !(r as { isDefinition?: boolean }).isDefinition,
  )
  return spansToLocations(st, filtered)
}

export function hoverRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, text, offset } = docContext(params)
  const info = project.service.getQuickInfoAtPosition(file, offset)
  if (!info) return null
  const signature = st.ts.displayPartsToString(info.displayParts ?? [])
  const docs = st.ts.displayPartsToString(info.documentation ?? [])
  const value =
    '```typescript\n' + signature + '\n```' + (docs ? `\n${docs}` : '')
  return {
    contents: { kind: 'markdown', value },
    range: spanToRange(text, info.textSpan.start, info.textSpan.length),
  }
}

export function documentSymbolRequest(params: unknown, docContext: DocContext): unknown {
  const { project, file, text } = docContext(params)
  const tree = project.service.getNavigationTree(file)
  return navTreeToSymbols(text, tree.childItems)
}

export function workspaceSymbolRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const p = params as { query?: string }
  const query = p.query ?? ''
  const seen = new Set<string>()
  const out: {
    name: string
    kind: number
    location: LspLocation
    containerName?: string
  }[] = []
  let firstError: string | undefined
  for (const project of new Set([...st.workspaceProjects(), ...st.allProjects()])) {
    let items: TS.NavigateToItem[] = []
    try {
      items = project.service.getNavigateToItems(query, 128, undefined, false, true)
    } catch (error) {
      passedOver(error)
      if (firstError === undefined) firstError = error instanceof Error ? error.message : String(error)
      logForDebugging(`tsSidecar workspace/symbol skipped throwing project ${project.key}: ${String(error)}`)
      continue
    }
    for (const item of items) {
      const file = st.normalize(item.fileName)
      const text = st.textOf(file)
      if (text === undefined) continue
      const key = `${file}:${item.textSpan.start}:${item.name}`
      if (seen.has(key)) continue
      seen.add(key)
      const entry: {
        name: string
        kind: number
        location: LspLocation
        containerName?: string
      } = {
        name: item.name,
        kind: symbolKindOf(item.kind),
        location: {
          uri: toUri(file),
          range: spanToRange(
            text,
            item.textSpan.start,
            item.textSpan.length,
          ),
        },
      }
      if (item.containerName) entry.containerName = item.containerName
      out.push(entry)
      if (out.length >= 256) break
    }
    if (out.length >= 256) break
  }
  return firstError !== undefined ? { symbols: out, incompleteError: firstError } : out
}
