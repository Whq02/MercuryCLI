import * as React from 'react'
import { useLoad } from '../../screen/effects/effects.js'
import { Text } from '../../screen/themedRenderer.js'
import { getCwd } from '../../platform/files/cwd.js'
import { readMediaGenerationDetails } from '../../integrations/media/generation.js'
import { readMediaPipelineDetails } from '../../integrations/media/pipeline.js'
import type { MediaKind } from '../../integrations/media/settings.js'
import { ConsentBodyText } from './ConsentBodyText.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'
import { PermissionDialog } from './PermissionDialog.js'
import type { PermissionRequestProps } from './PermissionRequest.js'

export function MediaPermissionRequest(props: PermissionRequestProps & { kind: MediaKind }): React.ReactNode {
  const [detail, setDetail] = React.useState<string | null>(null)
  useLoad(signal => {
    const { input, tool, cwd } = props.toolUseConfirm
    const project = cwd ?? getCwd()
    const detail = tool.mcpInfo?.toolName === 'pipeline_run'
      ? readMediaPipelineDetails(input, project)
      : readMediaGenerationDetails(props.kind, input, project)
    void detail.then(
      text => { if (!signal.aborted) setDetail(text) },
      error => { if (!signal.aborted) setDetail(String(error instanceof Error ? error.message : error)) },
    )
  }, [props.kind, props.toolUseConfirm.input, props.toolUseConfirm.cwd, props.toolUseConfirm.tool])
  const title = props.kind === 'image' ? 'Local image' : 'Local video'
  if (detail === null) return <PermissionDialog title={title} crewmate={props.toolUseConfirm.crewmate} workerBadge={props.workerBadge}><Text>{String(props.toolUseConfirm.input.model ?? `Default ${props.kind}`)}</Text></PermissionDialog>
  return <FallbackPermissionRequest {...props} screen="MediaPermissionRequest" title={title} body={<ConsentBodyText text={detail} />} />
}
