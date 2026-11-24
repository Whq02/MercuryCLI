import React from 'react';
import type { StatsStore } from '../platform/observability/stats.js';
import type { Root } from '../screen/themedRenderer.js';
import type { Props as ChatProps } from '../screen/chat/Chat.js';
import type { ScopedMcpServerConfig } from '../integrations/mcp-shapes/mcpServerRecords.js';
import type { AppState } from '../screen/app-state/AppStateStore.js';
import type { FpsMetrics } from '../screen/frame-rate/fpsTracker.js';
import { getProjectRoot, getSessionId } from './process-state/processState.js';
import { getCwd } from '../platform/files/cwd.js';
import { processMainOwner } from '../engine/run-owner/resolveOwner.js';
import { profileCheckpoint } from './startupProfiler.js';
import { logError } from '../platform/logs/errorLog.js';
import { passedOver } from '../platform/errors/passedOver.js';
import { withDeadline } from '../platform/async/deadline.js';

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
  void import('../daemon/switchboard/ensureDaemon.js')
    .then(m => m.warmSessionRunner(getCwd()))
    .catch(passedOver);

  try {
    const { runBootRecovery } = await import('../platform/substrate/recoveryOrchestrator.js');
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
    const { foldResumedRunForBoot } = await import('../engine/run/runCoordinator.js');
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
      import('../screen/routes/surfaceRoute.js'),
      import('./App.js'),
      import('../screen/routes/SurfaceRouter.js'),
    ]);
  const initialSurface = await resolveInitialSurface();
  profileCheckpoint('launch_chat_after_surface_resolution');

  const [{ Chat }, { seedDynamicMcpConfig }] = await Promise.all([
    import('../screen/chat/Chat.js'),
    import('../integrations/mcp/dynamicMcpSeed.js'),
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
