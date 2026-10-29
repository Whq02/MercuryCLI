import * as React from 'react'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { readMediaGenerationDetails } from '../../services/media/generation.js'
import { readMediaPipelineDetails } from '../../services/media/pipeline.js'
import type { MediaKind } from '../../services/media/settings.js'
import { ConsentBodyText } from './ConsentBodyText.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'
import { PermissionDialog } from './PermissionDialog.js'
import type { PermissionRequestProps } from './PermissionRequest.js'

export function MediaPermissionRequest(props: PermissionRequestProps & { kind: MediaKind }): React.ReactNode {
  const [detail, setDetail] = React.useState<string | null>(null)
  React.useEffect(() => {
    let active = true
    const { input, tool, cwd } = props.toolUseConfirm
    const project = cwd ?? getCwd()
    const detail = tool.mcpInfo?.toolName === 'pipeline_run'
      ? readMediaPipelineDetails(input, project)
      : readMediaGenerationDetails(props.kind, input, project)
    void detail.then(
      text => { if (active) setDetail(text) },
      error => { if (active) setDetail(String(error instanceof Error ? error.message : error)) },
    )
    return () => { active = false }
  }, [props.kind, props.toolUseConfirm.input, props.toolUseConfirm.cwd, props.toolUseConfirm.tool])
  const title = props.kind === 'image' ? 'Local image' : 'Local video'
  if (detail === null) return <PermissionDialog title={title} workerBadge={props.workerBadge}><Text>{String(props.toolUseConfirm.input.model ?? `Default ${props.kind}`)}</Text></PermissionDialog>
  return <FallbackPermissionRequest {...props} title={title} body={<ConsentBodyText text={detail} />} />
}
