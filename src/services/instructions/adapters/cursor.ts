import { sharedFormat, threeFields } from './shared.js'

export const cursorConvention = sharedFormat({
  id: 'cursor',
  label: 'Cursor',
  ruleSources: ['.cursor/rules', '.cursorrules'],
  rules: {
    accepts: name => name.endsWith('.mdc') || name.endsWith('.md'),
    read: (frontmatter, alone) => (alone ? { kind: 'always' } : (threeFields(frontmatter) ?? { kind: 'manual' })),
  },
})
