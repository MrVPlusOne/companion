import { buildThreadWindowSync } from "../../shared/thread-window.js";
import type { BrowserIncomingMessage, LeaderThreadResponseProjection } from "../types.js";
import snapshot from "./turn-activity-disclosure.json";

// Synthetic history finalized by the server producer, with complete answer proof.
// Its conformance test rebuilds the projection rather than inventing browser state.
export const turnActivityFixture = snapshot as {
  sessionId: string;
  threadKey: string;
  history: BrowserIncomingMessage[];
  projection: LeaderThreadResponseProjection;
};

export function buildTurnActivityFixtureWindow() {
  return buildThreadWindowSync({
    messageHistory: turnActivityFixture.history,
    currentThreadResponseProjection: turnActivityFixture.projection,
    threadKey: turnActivityFixture.threadKey,
    fromItem: 0,
    itemCount: 10,
    sectionItemCount: 10,
    visibleItemCount: 3,
  });
}
