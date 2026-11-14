import { scopeOf, sharedFormat, vendorPatterns } from './shared.js'

export const claudeConvention = sharedFormat({
  id: 'claude',
  label: 'Claude Code',
  guides: ['CLAUDE.md', '.claude/CLAUDE.md'],
  locals: ['CLAUDE.local.md'],
  ruleSources: ['.claude/rules'],
  rules: {
    accepts: name => name.endsWith('.md'),
    read(frontmatter) {
      const listed = frontmatter.paths
      if (listed === undefined || listed === null) return { kind: 'always' }
      const patterns = vendorPatterns(listed)
      return patterns.length > 0 ? scopeOf(patterns) : { kind: 'unsupported', detail: 'paths holds no pattern: the rule is not loaded' }
    },
  },
})
