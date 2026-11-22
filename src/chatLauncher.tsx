import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as ChatProps } from './screens/Chat.js';
import type { ScopedMcpServerConfig } from './utils/mcp/types.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { logError } from './utils/log.js';
import { passedOver } from './utils/passedOver.js';
import { withDeadline } from './utils/deadline.js';
import { notBuilt, type Unbuilt } from './pi/holes.js'
type AppWrapperProps = Unbuilt;
type McpSeed = {
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
};

const BOOT_RECOVERY_BUDGET_MS = 3_000;

export async function launchChat(root: Root, appProps: AppWrapperProps, chatProps: ChatProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>, mcpSeed?: McpSeed): Promise<void> {
  return notBuilt('src/chatLauncher.tsx:23')
}
