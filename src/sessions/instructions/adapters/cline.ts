import { scopeOf, sharedFormat, vendorPatterns } from './shared.js'

export const clineConvention = sharedFormat({
  id: 'cline',
  label: 'Cline',
  nearestOnly: true,
  ruleSources: ['.clinerules', '.cline/rules'],
  rules: {
    failsOpen: true,
    accepts: name => name.endsWith('.md'),
    read(frontmatter) {
      const listed = frontmatter.paths
      if (listed === undefined || listed === null) return { kind: 'always' }
      if (Array.isArray(listed) && listed.length === 0) return { kind: 'off' }
      const patterns = vendorPatterns(listed)
      return patterns.length > 0 ? scopeOf(patterns) : { kind: 'unsupported', detail: 'paths holds no pattern: the rule is not loaded' }
    },
  },
})
