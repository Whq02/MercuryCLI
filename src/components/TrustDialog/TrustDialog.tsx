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
// Does an allowedTools entry reference the Bash tool?
function toolAllowsBash(tool: string): boolean {
  return tool === BASH_TOOL_NAME || tool.startsWith(BASH_TOOL_NAME + "(");
}

// A checked-in (legacy-commands) prompt command with Bash access.
function isDeprecatedCommandWithBash(command: Command): boolean {
  return command.type === "prompt" && command.loadedFrom === "legacy-commands" && (command.source === "projectSettings" || command.source === "localSettings") && (command.allowedTools?.some(toolAllowsBash) ?? false);
}

// A skills/extension prompt command with Bash access.
function isSkillOrExtensionCommandWithBash(command: Command): boolean {
  return command.type === "prompt" && (command.loadedFrom === "skills" || command.loadedFrom === "extension") && (command.source === "projectSettings" || command.source === "localSettings" || command.source === "extension") && (command.allowedTools?.some(toolAllowsBash) ?? false);
}

export function TrustDialog({ onDone, commands }: Props): React.ReactNode {
  // Survey the project for trust-sensitive surfaces. We generally check only the
  // project-level and project-local-level settings, which we assume users do not
  // configure directly compared to user-level settings.
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
      // For home directory, store trust in session memory only (not persisted to disk).
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
    // ONE refusal contract: every way of declining trust — the No row, esc,
    // the exit chord, and this n shortcut — leaves with the same code.
    // This arm alone exited 0 while the rest exited 1: the same deliberate
    // "do not run here" read as success to whatever launched Mercury.
    gracefulShutdownSync(1);
  }, { context: "Confirmation" });

  if (hasTrustDialogAccepted) {
    setTimeout(onDone);
    return null;
  }

  // THE FIT SHED (the blind-Enter stranding class at the very first gate):
  // at short frames the explanatory paragraphs pushed the Yes/No off the
  // pane. The decision always paints — below the floor the prose sheds to
  // one compact question and the options stay on-screen.
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
        {/* IDENTITY RULE: the harness's one name is Mercury. A
            security-guide link would point at a docs site Mercury does
            not own — the guardrails step carries the warnings instead. */}
        {shortFrame ? null : <Text>Mercury will read, edit, and run the files here.</Text>}
        {/* Scope honesty: the grant persists at the project-config path —
            the git root when one exists — and a grant on a directory covers
            every descendant. Derived LIVE from the same owner the write
            uses, so the sentence and the grant can never disagree. */}
        {(() => {
          if (shortFrame) return null;
          const grantRoot = getProjectPathForConfig();
          // Compare in the key's own spelling: the grant root is a config
          // key (forward slashes, drive letter folded) while cwd() is the
          // OS spelling — on Windows the raw compare was never equal, so
          // every folder was told it sat "inside a repository" at a
          // forward-slash twin of itself (TASK-014 w1-f04-02 / w5-f11-01).
          if (grantRoot === normalizePathForConfigKey(getFsImplementation().cwd())) return null;
          return (
            <Text>
              This folder is inside a repository — trusting it covers the whole repository at{' '}
              <Text bold={true}>{grantRoot}</Text>, including its other folders and worktrees.
            </Text>
          );
        })()}
        <Select options={[{ label: "Yes, I trust this folder", value: "enable_all" }, { label: "No, exit", value: "exit" }]} onChange={(value: string) => onChange(value as 'enable_all' | 'exit')} onCancel={() => onChange("exit")} />
        {/* BFF-03: esc on the trust gate picks "No, exit" (the
            Select's onCancel) — it ends the process, it does not merely
            close a dialog; the footer says the truth in the card's own
            family spelling. */}
        <Text dimColor={true}>{exitState.pending ? <>{exitChordNoticeText(exitState.keyName ?? null)}</> : <><KeyboardShortcutHint shortcut="Enter" action="confirm" /> · <KeyboardShortcutHint shortcut="Esc" action="exits" /></>}</Text>
      </Box>
    </PermissionDialog>
  );
}
