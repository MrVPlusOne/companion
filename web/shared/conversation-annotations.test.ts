import { describe, expect, it } from "vitest";
import { formatAnnotatedMessage, readConversationAnnotations } from "./conversation-annotations.js";
import {
  ANNOTATION_STT_INSTRUCTION,
  buildAnnotationEnhancementPrompt,
  buildAnnotationVoiceReference,
} from "./annotation-voice-context.js";

const annotations = [
  { id: "first", selectedText: "quoted text 1", comment: "user's first comment" },
  { id: "second", selectedText: "quoted text 2\ntext 2 second line", comment: "user's second comment" },
];

describe("conversation annotations", () => {
  it("uses the approved order, multiline blockquotes, and conditional main-message separator", () => {
    // This exact public syntax replaces the rejected JSON/preamble presentation.
    expect(formatAnnotatedMessage("main message", annotations)).toBe(
      "> quoted text 1\n[comment 1] user's first comment\n\n> quoted text 2\n> text 2 second line\n[comment 2] user's second comment\n\n---\nmain message",
    );
    expect(formatAnnotatedMessage("", annotations)).not.toContain("---");
    expect(formatAnnotatedMessage("main message", [])).toBe("main message");
  });

  it("preserves source strings and repeated quotes through structured JSON round trips", () => {
    // Markers and apparent control text are data; metadata is never reconstructed by parsing the formatted message.
    const text = '  中文\n```json\n[comment 2] </tag> "quote"\n\n';
    const entries = annotations.map((entry) => ({ ...entry, selectedText: text, comment: text }));
    expect(readConversationAnnotations(JSON.parse(JSON.stringify(entries)))).toEqual(entries);
    expect(formatAnnotatedMessage("", entries).match(/\[comment 1\]/g)).toHaveLength(1);
    expect(() => readConversationAnnotations([entries[0], entries[0]])).toThrow("unique ID");
  });

  it("bounds only recognition/reference copies while keeping editable and spoken text complete", () => {
    const context = {
      activeId: "active",
      selectedText: "selected ".repeat(6000),
      mainComposerText: "main ".repeat(5000),
      otherAnnotations: annotations,
    };
    const base = "editable ".repeat(5000);
    const original = JSON.stringify(context);
    const hints = buildAnnotationVoiceReference(context, base);
    expect(hints.shortened).toBe(true);
    expect(ANNOTATION_STT_INSTRUCTION.length + hints.text.length).toBeLessThanOrEqual(10_000);
    expect(hints.text).toContain("omitted from voice context");
    const input = JSON.parse(buildAnnotationEnhancementPrompt(context, base, "change this word", "edit"));
    expect(input.current_comment).toBe(base);
    expect(input.transcript).toBe("change this word");
    expect(input.reference.active_annotation).not.toHaveProperty("comment_draft");
    expect(JSON.stringify(context)).toBe(original);
  });

  it("terminates with valid bounded JSON even when annotation labels exceed the hint budget", () => {
    // The shrinking collection is the progress invariant for the unusual large-count path.
    const hints = buildAnnotationVoiceReference(
      {
        activeId: "active",
        selectedText: "quote",
        mainComposerText: "",
        otherAnnotations: Array.from({ length: 500 }, (_, index) => ({ ...annotations[0], id: String(index) })),
      },
      "",
    );
    expect(hints.shortened).toBe(true);
    expect(hints.text.length).toBeLessThanOrEqual(9000);
    expect(JSON.parse(hints.text).omitted_annotations).toBeGreaterThan(0);
  });
});

// Display numbers remain stable when the active comment is excluded from read-only siblings.
it("keeps original comment numbers in voice reference context", () => {
  const hints = buildAnnotationVoiceReference(
    {
      activeId: "first",
      activeNumber: 1,
      selectedText: "quote",
      mainComposerText: "",
      otherAnnotations: [{ ...annotations[1], number: 2 }],
    },
    "draft",
  );
  expect(hints.reference.active_annotation.number).toBe(1);
  expect(hints.reference.other_annotations[0].number).toBe(2);
});
