import { z } from 'zod'

import { buildTool } from '../../Tool.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const TESTING_PERMISSION_TOOL_NAME = 'TestingPermission'

const inputSchema = z.strictObject({})

export const TestingPermissionTool: Unbuilt = unbuilt('src/tools/testing/TestingPermissionTool.tsx:10')
