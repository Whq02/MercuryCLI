import { useRef, useSyncExternalStore } from 'react';
import { getFocusedSessionConnector, subscribeFocusedSessionConnector, subscribeThroughFocused } from '../../engine/connector/focusedConnector.js';
import { hasSeatLive, IDLE_LIVE, type SessionLiveV1 } from '../../engine/connector/seatLive.js';

const subscribeFocusedSeatLive = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
);
export const getFocusedSeatLive = (): SessionLiveV1 => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? connector.live() : IDLE_LIVE;
};
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener));
const getFocusedEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective;
const subscribeFocusedTail = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.tail().subscribe(listener) : () => {},
);
const getFocusedTailActive = (): boolean => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? connector.tail().getSnapshot() !== null : false;
};
const getFocusedStatusKey = (): string => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? `${connector.status().interrupting ? 1 : 0}` : '0';
};

export function useChatFocusedSeat() {
  const focusedConnector = useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedSessionConnector, getFocusedSessionConnector);
  const seatLive = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedSeatLive, getFocusedSeatLive);
  const focusedEffectiveModel = useSyncExternalStore(subscribeFocusedModel, getFocusedEffectiveModel, getFocusedEffectiveModel);
  const textActive = useSyncExternalStore(subscribeFocusedTail, getFocusedTailActive, getFocusedTailActive);
  const interruptingKey = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedStatusKey, getFocusedStatusKey);
  const isStopping = interruptingKey === '1';
  const focusedTail = hasSeatLive(focusedConnector) ? focusedConnector.tail() : null;
  const isLoading = seatLive.inFlight;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  return { focusedConnector, seatLive, focusedEffectiveModel, textActive, interruptingKey, isStopping, focusedTail, isLoading, isLoadingRef };
}
