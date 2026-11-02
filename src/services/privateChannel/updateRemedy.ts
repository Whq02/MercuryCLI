import { HOMEBREW_UPGRADE_COMMAND, type InstallProvenanceV1 } from './installProvenance.js'

export function updateReinstallCommand(
  provenance: Pick<InstallProvenanceV1, 'kind' | 'invokedPath'>,
  npmWrapper: string | null,
  platform: string = process.platform,
): string {
  if (provenance.kind === 'homebrew') return HOMEBREW_UPGRADE_COMMAND
  if (provenance.kind === 'npm' || npmWrapper !== null) return 'npm i -g mercury-tech-cli@latest'
  if (platform === 'win32' && /[/\\]WinGet[/\\]Packages[/\\]MercuryCLI\.MercuryCLI_[^/\\]+[/\\]/i.test(provenance.invokedPath)) {
    return 'winget upgrade MercuryCLI.MercuryCLI'
  }
  return platform === 'win32'
    ? 'irm https://mercury-cli.ai/install.ps1 | iex'
    : 'curl -fsSL https://mercury-cli.ai/install.sh | sh'
}
