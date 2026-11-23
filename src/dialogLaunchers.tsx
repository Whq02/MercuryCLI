import type { Command } from './commands.js'
import type { StatsStore } from './context/stats.js'
import type { Root } from './ink.js'
import { SetupScreenHost } from './interactiveHelpers.js'
import type { AppState } from './state/AppStateStore.js'
import { featureReached } from './substrate/featureReached.js'
import type { Tool } from './Tool.js'
import { errorMessage } from './utils/errors.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { gracefulShutdownSync } from './utils/gracefulShutdown.js'
import { passedOver } from './utils/passedOver.js'
import type { ValidationError } from './utils/settings/validation.js'

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
    import('./components/InvalidSettingsDialog.js'),
    import('./state/AppState.js'),
    import('./keybindings/KeybindingProviderSetup.js'),
    import('./utils/settings/unknownKeyRemoval.js'),
    import('./substrate/bootNotes.js'),
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
  const [{ ResumeConversation }, { App }, { KeybindingSetup }, worktreePaths] = await Promise.all([
    import('./screens/ResumeConversation.js'),
    import('./components/App.js'),
    import('./keybindings/KeybindingProviderSetup.js'),
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
        <ResumeConversation
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
