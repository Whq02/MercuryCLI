import { join } from 'path'

import { getFsImplementation } from '../../../utils/fsOperations.js'
import type { InstructionConvention } from '../contracts.js'
import { sharedFormat, threeFields, triggered } from './shared.js'

const LEGACY_GLOBAL = '.windsurf/global_rules.md'
const PREFERRED_GLOBAL = '.devin/global_rules.md'

const family = sharedFormat({
  id: 'windsurf',
  label: 'Windsurf',
  ruleSources: ['.windsurfrules', LEGACY_GLOBAL, '.windsurf/rules', PREFERRED_GLOBAL, '.devin/rules'],
  rules: {
    accepts: name => name.endsWith('.md'),
    read: (frontmatter, alone) => (alone ? { kind: 'always' } : (triggered(frontmatter) ?? threeFields(frontmatter) ?? { kind: 'always' })),
  },
})

export const windsurfConvention: InstructionConvention = {
  ...family,
  projectRulesDirs(dir) {
    const sources = family.projectRulesDirs(dir)
    const legacy = join(dir, ...LEGACY_GLOBAL.split('/'))
    return getFsImplementation().existsSync(join(dir, ...PREFERRED_GLOBAL.split('/'))) ? sources.filter(source => source !== legacy) : sources
  },
}
