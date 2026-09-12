import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import {
  resolveSessionMessageTarget,
  searchSessionMessages,
  type MessageSearchScopeKind,
} from "../session-message-search.js";
import type { WsBridge } from "../ws-bridge.js";

export interface SessionMessageSearchRouteDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  resolveId: (idOrNum: string) => string | null;
}

const MESSAGE_SEARCH_SCOPES = new Set<MessageSearchScopeKind>(["session", "current_thread", "leader_all_tabs"]);

export function registerSessionMessageSearchRoute(api: Hono, deps: SessionMessageSearchRouteDeps): void {
  const { launcher, wsBridge, resolveId } = deps;
  api.get("/sessions/:id/message-target/:messageId", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(sessionId);
    const bridge = wsBridge.getSession(sessionId);
    if (!session || !bridge) return c.json({ error: "Session not found" }, 404);
    const target = resolveSessionMessageTarget(
      bridge.messageHistory,
      c.req.param("messageId"),
      session.isOrchestrator === true || bridge.state.isOrchestrator === true,
    );
    return target ? c.json(target) : c.json({ error: "Source message is unavailable" }, 404);
  });
  api.get("/sessions/:id/message-search", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const launcherSession = launcher.getSession(sessionId);
    if (!launcherSession) return c.json({ error: "Session not found" }, 404);

    const bridgeSession = wsBridge.getSession(sessionId);
    if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);

    const rawScope = c.req.query("scope");
    const requestedScope = MESSAGE_SEARCH_SCOPES.has(rawScope as MessageSearchScopeKind)
      ? (rawScope as MessageSearchScopeKind)
      : undefined;
    const response = searchSessionMessages({
      sessionId,
      sessionNum: launcher.getSessionNum(sessionId) ?? null,
      isLeaderSession: launcherSession.isOrchestrator === true || bridgeSession.state.isOrchestrator === true,
      messageHistory: bridgeSession.messageHistory,
      query: c.req.query("q") ?? "",
      scope: requestedScope,
      threadKey: c.req.query("threadKey") ?? null,
      filters: {
        user: parseBoolean(c.req.query("includeUser")),
        assistant: parseBoolean(c.req.query("includeAssistant")),
        event: parseBoolean(c.req.query("includeEvents")),
        starredOnly: parseBoolean(c.req.query("starredOnly")),
      },
      starredMessages: bridgeSession.state.starredMessages,
      limit: parseInteger(c.req.query("limit")),
      offset: parseInteger(c.req.query("offset")),
    });

    return c.json(response);
  });
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
