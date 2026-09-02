// Groups settings-validation errors by originating file into a rendered
// tree with the error messages as leaves, plus deduplicated suggestions.
// Intermediate path segments always create OBJECTS — a numeric segment must
// not silently create an array.

import React from 'react'
import { Box, Text } from '../ink.js'
import type { ValidationError } from '../utils/settings/validation.js'
import { treeify, type TreeNode } from '../utils/treeify.js'
import { useTheme } from './design-system/ThemeProvider.js'

const NO_FILE_LABEL = '(no file)'

/** Strings quoted, everything else stringified; null and undefined are
 *  spelled out (unreachable behind the outer guard, kept for totality). */
function formatInvalidValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}

function buildTree(errors: ValidationError[]): TreeNode {
  const root: TreeNode = {}
  for (const error of errors) {
    if (error.path === '') {
      // A path-less error becomes a root entry under the empty-string key.
      root[''] = error.message
      continue
    }
    const segments = error.path.split('.')
    // A non-nullish invalid value replaces a numeric FINAL segment.
    const last = segments[segments.length - 1]!
    if (
      error.invalidValue !== null &&
      error.invalidValue !== undefined &&
      /^\d+$/.test(last)
    ) {
      segments[segments.length - 1] = formatInvalidValue(error.invalidValue)
    }
    let node: TreeNode = root
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!
      const existing = node[segment]
      if (
        existing === undefined ||
        existing === null ||
        typeof existing !== 'object' ||
        Array.isArray(existing)
      ) {
        node[segment] = {}
      }
      node = node[segment] as TreeNode
    }
    node[segments[segments.length - 1]!] = error.message
  }
  return root
}

export function ValidationErrorsList({
  errors,
}: {
  errors: ValidationError[]
}): React.ReactNode {
  const [themeName] = useTheme()
  if (errors.length === 0) return null

  const byFile = new Map<string, ValidationError[]>()
  for (const error of errors) {
    const file = error.file ?? NO_FILE_LABEL
    const list = byFile.get(file)
    if (list) list.push(error)
    else byFile.set(file, [error])
  }
  const files = [...byFile.keys()].sort()

  return (
    <Box flexDirection="column">
      {files.map(file => {
        const fileErrors = [...(byFile.get(file) ?? [])].sort((a, b) => {
          // Root-level (path-less) errors first, then by path.
          if (a.path === '' && b.path !== '') return -1
          if (a.path !== '' && b.path === '') return 1
          return a.path.localeCompare(b.path)
        })
        const rendered = treeify(buildTree(fileErrors), {
          showValues: true,
          themeName,
          treeCharColors: { treeChar: 'inactive', key: 'text', value: 'inactive' },
        })
        // Distinct suggestion + documentation-link pairs, per file: a pair
        // is recorded when either half is present; the link participates in
        // the dedup key but is never displayed.
        const seen = new Set<string>()
        const suggestions: string[] = []
        for (const error of fileErrors) {
          if (error.suggestion === undefined && error.docLink === undefined) {
            continue
          }
          const key = `${error.suggestion ?? ''}\u0000${error.docLink ?? ''}`
          if (seen.has(key)) continue
          seen.add(key)
          if (error.suggestion !== undefined) suggestions.push(error.suggestion)
        }
        return (
          <Box key={file} flexDirection="column">
            <Text>{file}</Text>
            <Box paddingLeft={1}>
              <Text dimColor>{rendered}</Text>
            </Box>
            {suggestions.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                {suggestions.map((suggestion, index) => (
                  <Box key={index} marginBottom={1}>
                    <Text dimColor wrap="wrap">
                      {suggestion}
                    </Text>
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

export default ValidationErrorsList
