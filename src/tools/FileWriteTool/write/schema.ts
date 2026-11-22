import { z } from 'zod/v4'

import { gitDiffSchema, hunkSchema, type FileEditOutput } from '../../FileEditTool/types.js'
import { unbuilt, type Unbuilt } from '../../../pi/holes.js'

export const inputSchema: Unbuilt = unbuilt('src/tools/FileWriteTool/write/schema.ts:5')

export type FileWriteToolInput = Unbuilt

export type Input = Unbuilt

export type Output = Unbuilt

export const outputSchema: Unbuilt = unbuilt('src/tools/FileWriteTool/write/schema.ts:28')
