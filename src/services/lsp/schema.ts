import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { lazySchema } from '../../utils/lazySchema.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const LspServerConfigSchema: Unbuilt = unbuilt('src/services/lsp/schema.ts:5')
