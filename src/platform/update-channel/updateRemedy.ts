import { HOMEBREW_UPGRADE_COMMAND, NIX_UPDATE_WORDS, type InstallProvenanceV1 } from './installProvenance.js'
import { mercuryInstallUpdateCommand } from '../host-os/words.js'

export function updateReinstallCommand(
  provenance: Pick<InstallProvenanceV1, 'kind' | 'invokedPath'>,
  npmWrapper: string | null,
  platform: string = process.platform,
): string {
  if (provenance.kind === 'nix') return NIX_UPDATE_WORDS
  if (provenance.kind === 'homebrew') return HOMEBREW_UPGRADE_COMMAND
  if (provenance.kind === 'npm' || npmWrapper !== null) return 'npm i -g mercury-tech-cli@latest'
  return mercuryInstallUpdateCommand(provenance.invokedPath, platform)
}
