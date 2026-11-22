import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const CROSS_PLATFORM_CODE_EXEC: Unbuilt = unbuilt('src/utils/permissions/dangerousPatterns.ts:2')

export const DANGEROUS_BASH_PATTERNS: string[] = unbuilt('src/utils/permissions/dangerousPatterns.ts:24')

export const PROGRAM_WRAPPERS: string[] = unbuilt('src/utils/permissions/dangerousPatterns.ts:35')
