import { sharedFormat, threeFields } from './shared.js'

const LEGACY_FILE = '.cursorrules'

export const cursorConvention = sharedFormat({
  id: 'cursor',
  label: 'Cursor',
  ruleSources: ['.cursor/rules', LEGACY_FILE],
  rules: {
    accepts: name => name.endsWith('.mdc') || name.endsWith('.md'),
    read: (frontmatter, name) => (name === LEGACY_FILE ? { kind: 'always' } : (threeFields(frontmatter) ?? { kind: 'manual' })),
  },
})
