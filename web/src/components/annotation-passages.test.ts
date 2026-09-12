// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { captureAnnotationSource, resolveAnnotationRange } from "./annotation-passages.js";
import { readConversationAnnotations, formatAnnotatedMessage } from "../../shared/conversation-annotations.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function source() {
  document.body.innerHTML =
    '<div data-message-id="source"><div data-chat-selection-scope="true">Same <b>phrase</b>. Same <a href="#link">phrase</a>.</div><div data-chat-selection-scope="true">Another scope.</div></div>';
  return document.body.firstElementChild as HTMLElement;
}

describe("annotation passage identity", () => {
  it("retains the selected repeated occurrence across storage and remount without changing text or agent formatting", () => {
    // A literal search alone cannot distinguish the two identical phrases in this rendered message.
    const root = source();
    const range = document.createRange();
    range.selectNodeContents(root.querySelector("a")!);
    const selected = {
      id: "comment",
      selectedText: "phrase",
      comment: "Explain the second occurrence.",
      ...captureAnnotationSource(range),
    };
    const [stored] = readConversationAnnotations(JSON.parse(JSON.stringify([selected])));
    const remounted = source();
    const resolved = resolveAnnotationRange(remounted, stored)!;
    expect(resolved.startContainer.parentElement?.tagName).toBe("A");
    expect(resolved.toString()).toBe("phrase");
    expect(formatAnnotatedMessage("", [stored])).toBe("> phrase\n[comment 1] Explain the second occurrence.");
    expect(remounted.querySelector("a")?.getAttribute("href")).toBe("#link");
  });

  it("anchors a whole scope spanning formatted inline nodes", () => {
    const root = source();
    const scope = root.querySelector("[data-chat-selection-scope]")!;
    const range = document.createRange();
    range.selectNodeContents(scope);
    const annotation = {
      id: "whole",
      selectedText: range.toString(),
      comment: "Whole paragraph",
      ...captureAnnotationSource(range),
    };
    expect(resolveAnnotationRange(root, annotation)?.toString()).toBe(scope.textContent);
  });

  it("does not retarget changed anchored text or guess among repeated legacy quotations", () => {
    const root = source();
    const legacy = { id: "legacy", selectedText: "phrase", comment: "Which one?" };
    expect(resolveAnnotationRange(root, legacy)).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(root.querySelector("a")!);
    const anchored = { ...legacy, ...captureAnnotationSource(range) };
    root.querySelector("a")!.textContent = "changed";
    expect(resolveAnnotationRange(root, anchored)).toBeNull();
    expect(resolveAnnotationRange(root, legacy)?.startContainer.parentElement?.tagName).toBe("B");
  });

  it("rejects malformed source offsets while preserving old annotations without anchors", () => {
    const legacy = { id: "legacy", selectedText: "text", comment: "comment" };
    expect(readConversationAnnotations([legacy])).toEqual([legacy]);
    expect(() =>
      readConversationAnnotations([{ ...legacy, sourceAnchor: { scopeIndex: 0, start: 1, end: 8, text: "text" } }]),
    ).toThrow("Invalid annotation source anchor");
  });
});
