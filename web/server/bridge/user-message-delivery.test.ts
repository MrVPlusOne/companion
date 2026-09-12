import { describe, expect, it } from "vitest";
import { normalizeAdapterUserMessage, prepareAnnotatedUserMessage } from "./user-message-delivery.js";

describe("annotation message delivery", () => {
  it("derives delivery from structured attachments while retaining the separately displayed main message", () => {
    // A browser-supplied delivery string cannot replace authoritative annotation formatting.
    const annotations = [{ id: "note", selectedText: "reference\nsecond line", comment: "Explain this." }];
    const prepared = prepareAnnotatedUserMessage("session", {
      type: "user_message",
      content: "Main message",
      annotations,
      deliveryContent: "stale browser formatting",
      replyContext: { previewText: "Question", messageId: "source" },
      threadKey: "main",
    });
    expect(prepared.content).toBe("Main message");
    expect(prepared.annotations).toEqual(annotations);
    expect(prepared.deliveryContent).toBe(
      "[reply] Question\n\n> reference\n> second line\n[comment 1] Explain this.\n\n---\nMain message",
    );
    const delivered = normalizeAdapterUserMessage({ id: "session" }, prepared, undefined);
    expect(delivered).toMatchObject({ type: "user_message", content: prepared.deliveryContent });
    expect(delivered).not.toHaveProperty("deliveryContent");
  });

  it("keeps later server delivery additions and compiles retries without duplicate annotations", () => {
    const prepared = prepareAnnotatedUserMessage("session", {
      type: "user_message",
      content: "",
      annotations: [{ id: "note", selectedText: "quote", comment: "Question?" }],
    });
    // Startup/recovery preludes are added after ingress preparation and must survive adapter normalization.
    const withPrelude = { ...prepared, deliveryContent: prepared.deliveryContent + "\nServer context" };
    expect(normalizeAdapterUserMessage({ id: "session" }, withPrelude, undefined)).toMatchObject({
      content: "> quote\n[comment 1] Question?\nServer context",
    });
    const retry = prepareAnnotatedUserMessage("session", prepared);
    expect(retry.deliveryContent).toBe(prepared.deliveryContent);
  });

  it("rejects malformed attachment structure before treating it as a user message", () => {
    expect(() =>
      prepareAnnotatedUserMessage("session", {
        type: "user_message",
        content: "",
        annotations: [{ id: "a", selectedText: "quote", comment: "" }],
      }),
    ).toThrow();
  });
});

// Processed image references stay path-only even when the server composes annotation text itself.
it("combines annotations with image paths without forwarding raw image fields", () => {
  const prepared = prepareAnnotatedUserMessage("session", {
    type: "user_message",
    content: "Inspect both",
    annotations: [{ id: "note", selectedText: "quote", comment: "Explain this" }],
    imageRefs: [{ imageId: "image-one", media_type: "image/png", optimized: true }],
  });
  const delivered = normalizeAdapterUserMessage({ id: "session" }, prepared, prepared.imageRefs)!;
  expect(delivered).not.toHaveProperty("images");
  expect(delivered).not.toHaveProperty("imageRefs");
  expect(JSON.stringify(delivered)).not.toContain("data:image");
  if (delivered.type !== "user_message") throw new Error("Expected user delivery");
  expect(delivered.content).toContain("[comment 1] Explain this");
  expect(delivered.content).toContain("Attachment 1:");
  expect(delivered.content.match(/Attachment 1:/g)).toHaveLength(1);
});
