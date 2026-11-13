import { describedBy, scopeOf, sharedFormat, vendorPatterns } from './shared.js'

export const copilotConvention = sharedFormat({
  id: 'copilot',
  label: 'Copilot',
  guides: ['.github/copilot-instructions.md'],
  ruleSources: ['.github/instructions'],
  rules: {
    accepts: name => name.endsWith('.instructions.md'),
    read(frontmatter) {
      const patterns = vendorPatterns(frontmatter.applyTo)
      if (patterns.length > 0) return scopeOf(patterns)
      if (frontmatter.applyTo !== undefined && frontmatter.applyTo !== null) {
        return { kind: 'unsupported', detail: 'applyTo holds no pattern: the rule is not loaded' }
      }
      const description = describedBy(frontmatter)
      return description === '' ? { kind: 'manual' } : { kind: 'offered', description }
    },
  },
})
