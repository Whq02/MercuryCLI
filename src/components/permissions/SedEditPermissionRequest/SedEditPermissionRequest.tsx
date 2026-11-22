import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useLoad } from '../../../hooks/effects.js'
import { promises as fs } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isENOENT } from '../../../utils/errors.js'
import { detectEncodingForResolvedPath } from '../../../utils/fileRead.js'
import {
  applySedSubstitution,
  type SedEditInfo,
} from '../../../tools/BashTool/sedEditParser.js'
import { ConsentFileEditDiff } from '../ConsentFileEditDiff.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { ToolInput } from '../FilePermissionDialog/permissionOptions.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { notBuilt } from '../../../pi/holes.js'

type LoadedFile = { exists: boolean; content: string; beforeBytes?: string }

export function SedEditPermissionRequest(arg0: PermissionRequestProps & { sedEditInfo: SedEditInfo }): React.ReactNode {
  return notBuilt('src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx:21')
}
