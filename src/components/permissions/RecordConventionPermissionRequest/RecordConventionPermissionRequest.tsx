import * as React from 'react'
import { useMemo } from 'react'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import {
  describeCaptureResult,
  planProjectInstruction,
  resolveCaptureTargetPath,
} from '../../../services/instructions/projectInstructionWriter.js'
import { ConsentFileEditDiff } from '../ConsentFileEditDiff.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type RecordConventionInput = {
  rule: string
  replaces?: string
}

function parseRecordConventionInput(input: unknown): RecordConventionInput {
  return input as RecordConventionInput
}

export function RecordConventionPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseRecordConventionInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )
  const cwd = getFocusedSessionConnector().workspace().cwd
  const plan = useMemo(
    () => planProjectInstruction({ cwd, rule: parsed.rule ?? '', replaces: parsed.replaces }),
    [cwd, parsed.rule, parsed.replaces],
  )
  const path = plan.write ? plan.path : resolveCaptureTargetPath(cwd)
  const name = basename(path)
  const verb = plan.write && plan.result.action === 'updated' ? 'replace the rule in' : 'record this rule in'

  return (
    <FilePermissionDialog<RecordConventionInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Record a convention"
      subtitle={relative(cwd, path)}
      question={
        <Text bold>
          Do you want to {verb} <Text bold>{name}</Text>?
        </Text>
      }
      content={
        plan.write ? (
          <ConsentFileEditDiff
            file_path={path}
            edits={[{ old_string: plan.before, new_string: plan.after, replace_all: false }]}
          />
        ) : (
          <Text dimColor>{describeCaptureResult(plan.result)}</Text>
        )
      }
      operationType={plan.write && plan.before === '' ? 'create' : 'write'}
      path={path}
      parseInput={parseRecordConventionInput}
      workerBadge={workerBadge}
    />
  )
}
