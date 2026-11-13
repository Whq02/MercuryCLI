import { SHARED_INSTRUCTION_FILE } from './agentsMd.js'
import { sharedFormat, threeFields, triggered } from './shared.js'

export const agentFoldersConvention = sharedFormat({
  id: 'agent-folders',
  label: 'shared folder',
  guides: [`.agent/${SHARED_INSTRUCTION_FILE}`, `.agents/${SHARED_INSTRUCTION_FILE}`],
  ruleSources: ['.agent/rules', '.agents/rules'],
  rules: {
    accepts: name => name.endsWith('.md') || name.endsWith('.mdc'),
    read: frontmatter => triggered(frontmatter) ?? threeFields(frontmatter) ?? { kind: 'always' },
  },
})
