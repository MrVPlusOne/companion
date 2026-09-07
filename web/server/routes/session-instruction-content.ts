import type { Hono } from "hono";
import { MAX_INSTRUCTION_CONTENT_BYTES } from "../../shared/codex-instruction-content.js";
import type { CodexInstructionContentResponse } from "../../shared/codex-instruction-content.js";
import type { RouteContext } from "./context.js";
import { resolveCapturedInstructionContent } from "../codex-instruction-content.js";

/** Reveal one retained body using snapshot identity and source index, never a client-supplied path. */
export function registerSessionInstructionContentRoute(
  api: Hono,
  {
    launcher,
    resolveId,
  }: Pick<RouteContext, "resolveId"> & {
    launcher: Pick<RouteContext["launcher"], "getSession">;
  },
): void {
  api.get("/sessions/:id/instruction-content", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = resolveId(c.req.param("id"));
    const session = id ? launcher.getSession(id) : undefined;
    if (!session || session.backendType !== "codex") return c.json({ error: "Codex session not found" }, 404);

    const threadId = c.req.query("threadId");
    const capturedAt = Number(c.req.query("capturedAt"));
    const source = c.req.query("source");
    if (!threadId || !Number.isSafeInteger(capturedAt) || capturedAt <= 0 || source === undefined) {
      return c.json({ error: "A captured instruction snapshot and source are required" }, 400);
    }
    const snapshot = session.codexInstructionSnapshot;
    if (
      !snapshot ||
      snapshot.threadId !== threadId ||
      snapshot.capturedAt !== capturedAt ||
      (session.cliSessionId && session.cliSessionId !== threadId)
    ) {
      return c.json(
        { error: "The instruction snapshot changed. Reopen Session Info to view its current sources." },
        409,
      );
    }
    const index = /^(0|[1-9]\d*)$/.test(source) ? Number(source) : -1;
    if (
      source !== "generated" &&
      (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.instructionSources.length)
    ) {
      return c.json({ error: "Instruction source not found in this snapshot" }, 404);
    }
    const captured = await resolveCapturedInstructionContent(snapshot, source);
    // A relaunch during the bounded evidence read must not return the previous thread's body.
    const currentSession = launcher.getSession(id!);
    if (
      currentSession?.codexInstructionSnapshot !== snapshot ||
      (currentSession.cliSessionId && currentSession.cliSessionId !== threadId)
    ) {
      return c.json(
        { error: "The instruction snapshot changed. Reopen Session Info to view its current sources." },
        409,
      );
    }
    const oversized =
      typeof captured?.content === "string" &&
      Buffer.byteLength(captured.content, "utf8") > MAX_INSTRUCTION_CONTENT_BYTES;
    const response: CodexInstructionContentResponse = {
      threadId,
      capturedAt,
      source,
      content: oversized ? null : (captured?.content ?? null),
    };
    if (response.content === null) {
      response.unavailableReason = oversized
        ? "The captured source exceeds the content viewer's size limit."
        : (captured?.unavailableReason ?? "Content was not captured for this instruction snapshot.");
    }
    return c.json(response);
  });
}
