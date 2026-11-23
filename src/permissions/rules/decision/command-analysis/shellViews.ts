import { type Node } from '../../../../platform/shell/bash/parser.js'

function asNode(value: unknown): Node | null {
  if (value && typeof value === 'object' && 'type' in value && 'children' in value) {
    return value as Node
  }
  return null
}

export function commandViewTexts(rootNode: unknown): string[] {
  const root = asNode(rootNode)
  if (root === null) return []
  const views: string[] = []
  const visit = (node: Node): void => {
    if (['command', 'redirected_statement', 'pipeline', 'file_redirect'].includes(node.type)) {
      views.push(node.text)
      const substitutions = (child: Node): void => {
        if (child.type === 'command_substitution') visit(child)
        else for (const nested of child.children) substitutions(nested)
      }
      for (const child of node.children) substitutions(child)
    } else for (const child of node.children) visit(child)
  }
  visit(root)
  return views
}

export function commandSubstitutionTexts(rootNode: unknown): string[] {
  const root = asNode(rootNode)
  if (root === null) return []
  const views: string[] = []
  const substitutions = (node: Node): void => {
    if (node.type === 'command_substitution') views.push(node.text)
    else for (const child of node.children) substitutions(child)
  }
  substitutions(root)
  return views
}
