
import * as React from 'react'
import type { Root } from './ink.js'
import type { AppState } from './state/AppStateStore.js'
import type { StatsStore } from './context/stats.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import type { ValidationError } from './utils/settings/validation.js'
import { gracefulShutdownSync } from './utils/gracefulShutdown.js'
import { SetupScreenHost } from './interactiveHelpers.js'

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
  const [{ InvalidSettingsDialog }, { AppStateProvider }, { KeybindingSetup }] =
    await Promise.all([
      import('./components/InvalidSettingsDialog.js'),
      import('./state/AppState.js'),
      import('./keybindings/KeybindingProviderSetup.js'),
    ])
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <SetupScreenHost>
            <InvalidSettingsDialog
              settingsErrors={settingsErrors}
              onContinue={() => resolve()}
              onExit={onExit}
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

type ResumeScreenProps = React.ComponentProps<
  typeof import('./screens/ResumeConversation.js').ResumeConversation
>
type ResumeChooserProps = Pick<
  ResumeScreenProps,
  'commands' | 'initialTools' | 'debug' | 'disableSlashCommands' | 'initialSearchQuery' | 'forkSession' | 'filterByPr'
>

export async function launchResumeChooser(
  root: Root,
  appProps: ResumeAppProps,
  worktreePathsPromise: Promise<string[]>,
  resumeProps: ResumeChooserProps,
): Promise<void> {
  const [{ ResumeConversation }, { App }, { KeybindingSetup }, worktreePaths] =
    await Promise.all([
      import('./screens/ResumeConversation.js'),
      import('./components/App.js'),
      import('./keybindings/KeybindingProviderSetup.js'),
      worktreePathsPromise.catch(() => [] as string[]),
    ])
  root.render(
    <App {...appProps}>
      <KeybindingSetup>
        <ResumeConversation
          commands={resumeProps.commands}
          worktreePaths={worktreePaths}
          initialTools={resumeProps.initialTools}
          debug={resumeProps.debug}
          disableSlashCommands={resumeProps.disableSlashCommands}
          initialSearchQuery={resumeProps.initialSearchQuery}
          forkSession={resumeProps.forkSession}
          filterByPr={resumeProps.filterByPr}
        />
      </KeybindingSetup>
    </App>,
  )
  await root.waitUntilExit()
  gracefulShutdownSync(0)
}
