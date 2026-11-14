import { join } from 'path'

import { getOriginalCwd } from '../../../bootstrap/state.js'
import { expandPath } from '../../../utils/path.js'
import type { InstructionConvention } from '../contracts.js'
import { describedBy, scopeOf, sharedFormat, vendorPatterns } from './shared.js'

const NAMED_FOLDERS = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS'

const format = sharedFormat({
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

export const copilotConvention: InstructionConvention = {
  ...format,
  named() {
    const entries = (process.env[NAMED_FOLDERS] ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '')
    if (entries.length === 0) return null
    const folders = [...new Set(entries.map(entry => expandPath(entry, getOriginalCwd())))]
    return {
      by: NAMED_FOLDERS,
      folders: folders.map(folder => ({ folder, guides: [join(folder, 'AGENTS.md')], rules: [join(folder, '.github', 'instructions')] })),
    }
  },
}
