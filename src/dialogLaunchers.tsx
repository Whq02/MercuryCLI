import type { Root } from './ink.js'
import type { ValidationError } from './utils/settings/validation.js'
import { notBuilt, type Unbuilt } from './pi/holes.js'

export async function launchInvalidSettingsDialog(
  root: Root,
  arg1: {
    settingsErrors: ValidationError[]
    onExit: () => void
  },
): Promise<void> {
  return notBuilt('src/dialogLaunchers.tsx:14')
}

type ResumeAppProps = Unbuilt
type ResumeChooserProps = Unbuilt

export async function launchResumeChooser(
  root: Root,
  appProps: ResumeAppProps,
  worktreePathsPromise: Promise<string[]>,
  resumeProps: ResumeChooserProps,
): Promise<void> {
  return notBuilt('src/dialogLaunchers.tsx:78')
}
