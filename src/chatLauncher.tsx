import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as ChatProps } from './screens/Chat.js';
import type { ScopedMcpServerConfig } from './utils/mcp/types.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { getProjectRoot, getSessionId } from './bootstrap/state.js';
import { getCwd } from './utils/cwd.js';
import { processMainOwner } from './utils/run/resolveOwner.js';
import { profileCheckpoint } from './utils/startupProfiler.js';
import { logError } from './utils/log.js';
import { passedOver } from './utils/passedOver.js';
import { withDeadline } from './utils/deadline.js';

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};
type McpSeed = {
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
};

const BOOT_RECOVERY_BUDGET_MS = 3_000;

export async function launchChat(
  root: Root,
  appProps: AppWrapperProps,
  chatProps: ChatProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
  mcpSeed?: McpSeed,
): Promise<void> {
  profileCheckpoint('launch_chat_start');

  try {
    const { runBootRecovery } = await import('./substrate/recoveryOrchestrator.js');
    await withDeadline(
      runBootRecovery({
        scope: 'session',
        sessionId: getSessionId(),
        projectDir: getProjectRoot(),
      }),
      BOOT_RECOVERY_BUDGET_MS,
      () => undefined,
    );
  } catch (error) {
    logError(error);
    passedOver(error);
  }

  try {
    const { foldResumedRunForBoot } = await import('./services/run/runCoordinator.js');
    await withDeadline(
      foldResumedRunForBoot(processMainOwner(), getCwd()),
      BOOT_RECOVERY_BUDGET_MS,
      () => undefined,
    );
  } catch (error) {
    logError(error);
    passedOver(error);
  }

  profileCheckpoint('launch_chat_after_recovery');

  const [{ resolveInitialSurface, initializeSurfaceRoute }, { App }, { SurfaceRouter }] =
    await Promise.all([
      import('./context/surfaceRoute.js'),
      import('./components/App.js'),
      import('./components/SurfaceRouter.js'),
    ]);
  const initialSurface = await resolveInitialSurface();
  profileCheckpoint('launch_chat_after_surface_resolution');

  const [{ Chat }, { seedDynamicMcpConfig }] = await Promise.all([
    import('./screens/Chat.js'),
    import('./services/mcp/dynamicMcpSeed.js'),
  ]);
  seedDynamicMcpConfig(mcpSeed?.dynamicMcpConfig, mcpSeed?.isStrictMcpConfig ?? false);
  initializeSurfaceRoute(initialSurface.effective);
  profileCheckpoint('launch_chat_after_paint_imports');

  await renderAndRun(
    root,
    <App {...appProps}>
      <SurfaceRouter>
        <Chat {...chatProps} />
      </SurfaceRouter>
    </App>,
  );
}
