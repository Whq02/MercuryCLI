import { homedir } from 'os';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import React from 'react';
import { setSessionTrustAccepted } from '../../bootstrap/state.js';
import type { Command } from '../../commands.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getMcpConfigsByScope } from '../../services/mcp/config.js';
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js';
import { checkHasTrustDialogAccepted, getProjectPathForConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { getCwd } from '../../utils/cwd.js';
import { getFsImplementation } from '../../utils/fsOperations.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { normalizePathForConfigKey } from '../../utils/path.js';
import { Select } from '../CustomSelect/index.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
import { getApiKeyHelperSources, getAutoMemoryDirectorySources, getBashPermissionSources, getDangerousEnvVarsSources, getHooksSources, getProxyAuthHelperSources } from './utils.js';
type Props = {
  onDone(): void;
  commands?: Command[];
};
function toolAllowsBash(tool: string): boolean {
  return tool === BASH_TOOL_NAME || tool.startsWith(BASH_TOOL_NAME + "(");
}

function isDeprecatedCommandWithBash(command: Command): boolean {
  return command.type === "prompt" && command.loadedFrom === "legacy-commands" && (command.source === "projectSettings" || command.source === "localSettings") && (command.allowedTools?.some(toolAllowsBash) ?? false);
}

function isSkillOrExtensionCommandWithBash(command: Command): boolean {
  return command.type === "prompt" && (command.loadedFrom === "skills" || command.loadedFrom === "extension") && (command.source === "projectSettings" || command.source === "localSettings" || command.source === "extension") && (command.allowedTools?.some(toolAllowsBash) ?? false);
}

export function TrustDialog({ onDone, commands }: Props): React.ReactNode {
  const { servers: projectServers } = getMcpConfigsByScope("project");
  const hasMcpServers = Object.keys(projectServers).length > 0;
  const hasHooks = getHooksSources().length > 0;
  const bashSettingSources = getBashPermissionSources();
  const hasApiKeyHelper = getApiKeyHelperSources().length > 0;
  const hasProxyAuthHelper = getProxyAuthHelperSources().length > 0;
  const hasDangerousEnvVars = getDangerousEnvVarsSources().length > 0;
  const hasAutoMemoryDirectory = getAutoMemoryDirectorySources().length > 0;

  const hasSlashCommandBash = commands?.some(isDeprecatedCommandWithBash) ?? false;
  const hasSkillsBash = commands?.some(isSkillOrExtensionCommandWithBash) ?? false;
  const hasAnyBashExecution = bashSettingSources.length > 0 || hasSlashCommandBash || hasSkillsBash;

  const { rows } = useTerminalSize();
  const hasTrustDialogAccepted = checkHasTrustDialogAccepted();

  function onChange(value: 'enable_all' | 'exit'): void {
    if (value === "exit") {
      gracefulShutdownSync(1);
      return;
    }
    const isHomeDir = homedir() === getCwd();
    if (isHomeDir) {
      setSessionTrustAccepted(true);
    } else {
      saveCurrentProjectConfig(current => ({
        ...current,
        hasTrustDialogAccepted: true,
      }));
    }
    onDone();
  }

  const exitState = useExitOnCtrlCDWithKeybindings(() => gracefulShutdownSync(1));
  useKeybinding("confirm:no", () => {
    gracefulShutdownSync(1);
  }, { context: "Confirmation" });

  if (hasTrustDialogAccepted) {
    setTimeout(onDone);
    return null;
  }

  const shortFrame = rows < 18;
  return (
    <PermissionDialog color="warning" titleColor="warning" title="Accessing workspace:">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold={true}>{getFsImplementation().cwd()}</Text>
        {shortFrame ? (
          <Text>Trust this folder? Mercury will read, edit, and run the files here.</Text>
        ) : (
        <Text>Is this a project you created, or one you trust — your own code, a well-known open-source project, your team{"'"}s work? If not, look through the folder before continuing.</Text>
        )}
        {
}
        {shortFrame ? null : <Text>Mercury will read, edit, and run the files here.</Text>}
        {
}
        {(() => {
          if (shortFrame) return null;
          const grantRoot = getProjectPathForConfig();
          if (grantRoot === normalizePathForConfigKey(getFsImplementation().cwd())) return null;
          return (
            <Text>
              This folder is inside a repository — trusting it covers the whole repository at{' '}
              <Text bold={true}>{grantRoot}</Text>, including its other folders and worktrees.
            </Text>
          );
        })()}
        <Select options={[{ label: "Yes, I trust this folder", value: "enable_all" }, { label: "No, exit", value: "exit" }]} onChange={(value: string) => onChange(value as 'enable_all' | 'exit')} onCancel={() => onChange("exit")} />
        {
}
        <Text dimColor={true}>{exitState.pending ? <>{exitChordNoticeText(exitState.keyName ?? null)}</> : <><KeyboardShortcutHint shortcut="Enter" action="confirm" /> · <KeyboardShortcutHint shortcut="Esc" action="exits" /></>}</Text>
      </Box>
    </PermissionDialog>
  );
}
