import type { Command } from '../commands/catalogue/commands.js'
import type { StatsStore } from '../platform/observability/stats.js'
import type { Root } from '../screen/themedRenderer.js'
import { SetupScreenHost } from './setupScreens.js'
import type { AppState } from '../screen/app-state/AppStateStore.js'
import { featureReached } from '../platform/substrate/featureReached.js'
import type { Tool } from '../tools/kit/tool.js'
import { errorMessage } from '../platform/errors/errors.js'
import type { FpsMetrics } from '../screen/frame-rate/fpsTracker.js'
import { gracefulShutdownSync } from '../platform/processes/gracefulShutdown.js'
import { passedOver } from '../platform/errors/passedOver.js'
import type { ValidationError } from '../platform/settings/validation.js'

export async function launchInvalidSettingsDialog(
  root: Root,
  {
    settingsErrors,
    onExit,
  }: {
    settingsErrors: ValidationError[]
    onExit: () => void
  },
): Promise<void> {
  const [
    { InvalidSettingsDialog },
    { AppStateProvider },
    { KeybindingSetup },
    { removableUnknownKeys, removeUnknownKeys },
    { addBootNote },
  ] = await Promise.all([
    import('./first-run/InvalidSettingsDialog.js'),
    import('../screen/app-state/AppState.js'),
    import('../screen/keys/KeybindingProviderSetup.js'),
    import('../platform/settings/unknownKeyRemoval.js'),
    import('../platform/substrate/bootNotes.js'),
  ])
  const removals = removableUnknownKeys(settingsErrors)
  await new Promise<void>(resolve => {
    const onRemove =
      removals.length === 0
        ? undefined
        : () => {
            const fault = removeUnknownKeys(removals)
            if (fault !== null) {
              addBootNote(
                'warn',
                `settings: the unrecognized fields were not removed — ${fault.message}`,
              )
            }
            resolve()
          }
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <SetupScreenHost>
            <InvalidSettingsDialog
              settingsErrors={settingsErrors}
              onContinue={resolve}
              onExit={onExit}
              onRemove={onRemove}
            />
          </SetupScreenHost>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
}

type ResumeAppProps = {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
}

type ResumeChooserProps = {
  commands: Command[]
  initialTools: Tool[]
  debug?: boolean
  disableSlashCommands?: boolean
  initialSearchQuery?: string
  forkSession?: boolean
  filterByPr?: boolean | number | string
}

export async function launchResumeChooser(
  root: Root,
  appProps: ResumeAppProps,
  worktreePathsPromise: Promise<string[]>,
  resumeProps: ResumeChooserProps,
): Promise<void> {
  let worktreeReadError: string | undefined
  const [{ ResumeSession }, { App }, { KeybindingSetup }, worktreePaths] = await Promise.all([
    import('../screen/chat/ResumeSession.js'),
    import('./App.js'),
    import('../screen/keys/KeybindingProviderSetup.js'),
    worktreePathsPromise.catch((error: unknown): string[] => {
      passedOver(error)
      worktreeReadError = errorMessage(error)
      return []
    }),
  ])
  featureReached('screen', 'ResumeConversation')
  root.render(
    <App {...appProps}>
      <KeybindingSetup>
        <ResumeSession
          {...resumeProps}
          worktreePaths={worktreePaths}
          worktreeReadError={worktreeReadError}
        />
      </KeybindingSetup>
    </App>,
  )
  await root.waitUntilExit()
  gracefulShutdownSync(0)
}
