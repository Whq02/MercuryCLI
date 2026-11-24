import React from 'react';
import { TranscriptSwap } from './CrewmateTranscript.js';
import { ExitFlow } from '../../commands/exit/ExitFlow.js';
import { FullscreenLayout } from '../fullscreen-layout/FullscreenLayout.js';
import { MercuryFrame } from '../frame-chips/MercuryFrame.js';
import { FocusedSessionStatusRow } from './SwitchboardTagBar.js';
import { CockpitBottomStatus } from '../cockpit/cockpitActiveContext.js';
import { Box } from '../themedRenderer.js';
import { KeybindingSetup } from '../keys/KeybindingProviderSetup.js';
import { getShortcutDisplay } from '../keys/shortcutFormat.js';
import { getCurrentWorktreeSession } from '../../platform/git/worktree/worktree.js';
import { ChatKeys } from './ChatKeys.js';
import type { useChatAsksCard } from './useChatAsks.js';
import type { useChatDialogPaints, useChatDialogs, useChatDialogsView } from './useChatDialogs.js';
import type { useChatScroll, useChatScrollPin } from './useChatScroll.js';
import { TranscriptFooter, type useChatSearch } from './useChatSearch.js';
import type { useChatRewindPickerView } from './useChatSelector.js';
import type { useChatStatusStrip } from './useChatStatus.js';
import { AnimatedTitle, type useChatTitle } from './useChatTitle.js';
import type { useChatTools } from './useChatTools.js';

export type ChatKeysArgs = Omit<React.ComponentProps<typeof ChatKeys>, 'children'>;

type LegacyTreeArgs = Pick<ReturnType<typeof useChatTitle>, 'title' | 'titleAnimating'> &
  Pick<ReturnType<typeof useChatDialogs>, 'toolJSX'> &
  Pick<ReturnType<typeof useChatSearch>, 'dumpMode' | 'showAllInTranscript' | 'editorStatus'> & {
    terminalTitleEnabled: boolean;
    keys: ChatKeysArgs;
    messagesList: React.ReactNode;
  };

export function chatLegacyTree({ title, titleAnimating, toolJSX, dumpMode, showAllInTranscript, editorStatus, terminalTitleEnabled, keys, messagesList }: LegacyTreeArgs): React.ReactNode {
    return (
      <KeybindingSetup>
        <AnimatedTitle enabled={terminalTitleEnabled} title={title} wantsPrefix animating={titleAnimating} />
        <ChatKeys {...keys}>
          <Box flexDirection="column">
            {messagesList}
            {toolJSX?.jsx ?? null}
            <TranscriptFooter
              toggleChord={getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')}
              expandChord={getShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')}
              hasSearchBadge={false}
              virtualScroll={false}
              showAllSuppressed={dumpMode}
              showAll={showAllInTranscript}
              status={editorStatus}
              badge={null}
            />
          </Box>
        </ChatKeys>
      </KeybindingSetup>
    );
}

type TreeArgs = Pick<ReturnType<typeof useChatTitle>, 'title' | 'titleAnimating'> &
  Pick<ReturnType<typeof useChatScrollPin>, 'scrollRef' | 'modalScrollRef'> &
  Pick<ReturnType<typeof useChatStatusStrip>, 'workingStatusStrip' | 'spinnerSlotReserved'> &
  Pick<ReturnType<typeof useChatAsksCard>, 'permissionOverlay'> &
  Pick<ReturnType<typeof useChatDialogsView>, 'centredModalUp' | 'centredModal' | 'bottomImmediateJsx' | 'focusedBottomDialog'> &
  Pick<ReturnType<typeof useChatDialogPaints>, 'dialogOwnsKeys'> &
  Pick<ReturnType<typeof useChatScroll>, 'unseen' | 'newMessageCount' | 'onPillClick'> &
  Pick<ReturnType<typeof useChatSearch>, 'inVirtualTranscript' | 'onTranscriptPillClick' | 'screen' | 'showAllInTranscript'> &
  Pick<ReturnType<typeof useChatTools>, 'mergedTools' | 'commands' | 'agentDefinitions'> &
  Pick<ReturnType<typeof useChatDialogs>, 'showExitFlow' | 'setShowExitFlow' | 'exitCommandJsx'> &
  Pick<ReturnType<typeof useChatRewindPickerView>, 'messageSelector'> & {
    terminalTitleEnabled: boolean;
    keys: ChatKeysArgs;
    transcriptBody: React.ReactNode;
    isCompact: boolean;
    focusedEffectiveModel: string;
    bottomSlot: React.ReactNode;
  };

export function chatTree({ title, titleAnimating, scrollRef, modalScrollRef, workingStatusStrip, spinnerSlotReserved, permissionOverlay, centredModalUp, centredModal, bottomImmediateJsx, focusedBottomDialog, dialogOwnsKeys, unseen, newMessageCount, onPillClick, inVirtualTranscript, onTranscriptPillClick, screen, showAllInTranscript, mergedTools, commands, agentDefinitions, showExitFlow, setShowExitFlow, exitCommandJsx, messageSelector, terminalTitleEnabled, keys, transcriptBody, isCompact, focusedEffectiveModel, bottomSlot }: TreeArgs): React.ReactNode {
  const tree = (
    <KeybindingSetup>
      <AnimatedTitle enabled={terminalTitleEnabled} title={title} wantsPrefix animating={titleAnimating} />
      <ChatKeys {...keys}>
        <FullscreenLayout
          scrollRef={scrollRef}
          statusBand={inVirtualTranscript ? undefined : workingStatusStrip}
          statusBandActive={inVirtualTranscript ? undefined : spinnerSlotReserved}
          overlay={inVirtualTranscript ? undefined : permissionOverlay}
          modal={inVirtualTranscript ? undefined : centredModalUp ? centredModal : undefined}
          modalActive={dialogOwnsKeys}
          modalScrollRef={modalScrollRef}
          dividerYRef={unseen.dividerYRef}
          hidePill={inVirtualTranscript ? undefined : false}
          newMessageCount={inVirtualTranscript ? 0 : newMessageCount}
          onPillClick={inVirtualTranscript ? onTranscriptPillClick : onPillClick}
          scrollable={
            inVirtualTranscript ? transcriptBody : (
              <TranscriptSwap
                lead={transcriptBody}
                tools={mergedTools}
                commands={commands}
                screen={screen}
                agentDefinitions={agentDefinitions}
                scrollRef={scrollRef}
                showAllInTranscript={showAllInTranscript}
              />
            )
          }
          bottom={
            <Box flexDirection="column">
              {}
              <Box flexDirection={isCompact ? "column-reverse" : "column"}>
                <MercuryFrame model={focusedEffectiveModel} />
                <CockpitBottomStatus>{workingStatusStrip}</CockpitBottomStatus>
              </Box>
              {}
              {!isCompact ? <FocusedSessionStatusRow /> : null}
              {bottomImmediateJsx}
              {focusedBottomDialog}
              {showExitFlow ? (
                <ExitFlow
                  onDone={() => setShowExitFlow(false)}
                  onCancel={() => setShowExitFlow(false)}
                  showWorktree={getCurrentWorktreeSession() !== null}
                />
              ) : null}
              {exitCommandJsx}
              {bottomSlot}
              {messageSelector}
            </Box>
          }
        />
      </ChatKeys>
    </KeybindingSetup>
  );

  return tree;
}
