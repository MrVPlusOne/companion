import { describe, expect, it } from "vitest";
import {
  formatThreadMarker,
  inferThreadTargetFromTextContent,
  parseCommandThreadComment,
  parseThreadTextPrefix,
  parseThreadTextLineStartMarker,
  stripCommandThreadComment,
} from "./thread-routing.js";

describe("thread-routing", () => {
  it("round-trips individual timer firings and mixed human/firing answer references", () => {
    // Timer schedule IDs are intentionally different from answerable delivery IDs.
    for (const ids of [["timer-m1"], ["u1", "timer-m2"], ["timer-m1", "timer-m2"], ["f1"], ["f1", "timer-m2"]]) {
      const marker = formatThreadMarker("q-941", "answer", ids);
      for (const parse of [parseThreadTextPrefix, parseThreadTextLineStartMarker]) {
        expect(parse(`${marker}\nTimer result`)).toMatchObject({
          ok: true,
          role: "answer",
          answerUserMessageIds: ids,
          body: "Timer result",
        });
      }
    }
    for (const ids of [["t1"], ["timer-m0"], ["timer-m01"], ["timer-m1", "timer-m1"], ["f0"], ["f01"], ["f1", "f1"]]) {
      expect(() => formatThreadMarker("main", "answer", ids)).toThrow();
      expect(parseThreadTextPrefix(`[thread:main:A:${ids.join(",")}] Result`)).toMatchObject({
        ok: false,
        reason: "invalid_role",
      });
    }
  });

  it("round-trips compact commentary and explicit answer roles", () => {
    expect(formatThreadMarker("main", "answer", ["u1", "u2"])).toBe("[thread:main:A:u1,u2]");
    expect(formatThreadMarker("q-941", "commentary")).toBe("[thread:q-941:C]");
    expect(parseThreadTextPrefix("[thread:main:A:u1,u2]\nFinal answer")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      role: "answer",
      answerUserMessageIds: ["u1", "u2"],
      body: "Final answer",
    });
    expect(parseThreadTextPrefix("[thread:q-941:C] Progress update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      role: "commentary",
      body: "Progress update",
    });
    expect(parseThreadTextPrefix("[thread:q-941:X] Invalid role")).toMatchObject({
      ok: false,
      reason: "invalid_role",
    });
    for (const invalid of [
      "[thread:q-941:F] Retired role",
      "[thread:q-941:A] Missing IDs",
      "[thread:q-941:A:u1,] Trailing comma",
      "[thread:q-941:A:u01] Leading zero",
      "[thread:q-941:A:u1,u1] Duplicate",
      "[thread:q-941:C:u1] Commentary IDs",
    ]) {
      expect(parseThreadTextPrefix(invalid)).toMatchObject({ ok: false, reason: "invalid_role" });
    }
  });

  it("fails closed when one segment composes conflicting role-bearing markers", () => {
    for (const [text, marker] of [
      ["[thread:q-941:A:u1] [thread:q-941:C] Conflicting", "[thread:q-941:C]"],
      ["[thread:q-941:A:u1]\n[thread:q-941]\nMissing role", "[thread:q-941]"],
      ["[thread:q-941:A:u1]\nAnswer.\n[thread:q-941:X]\nUnknown role", "[thread:q-941:X]"],
      ["[thread:q-941:A:u1]\nAnswer.\n[thread:side:A:u1]\nUnknown target", "[thread:side:A:u1]"],
    ] as const) {
      expect(parseThreadTextPrefix(text)).toMatchObject({
        ok: false,
        reason: "invalid_role",
        marker,
      });
    }
  });

  it.each([
    ["triple backticks", "```text", "```"],
    ["tildes", "~~~text", "~~~~"],
    ["indented longer backticks", "  ````text", "  `````"],
  ] as const)("allows marker-like examples inside %s fences", (_, opening, closing) => {
    const body = ["Example:", opening, "---", "[thread:q-942:X]", closing].join("\n");
    expect(parseThreadTextPrefix(`[thread:q-941:A:u1]\n${body}`)).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      role: "answer",
      answerUserMessageIds: ["u1"],
      body,
    });
  });

  it("parses and strips mandatory leader text prefixes", () => {
    // Leader text routing is explicit per message so stale hidden current-thread
    // state cannot silently route a response to the wrong quest.
    expect(parseThreadTextPrefix("[thread:q-941]\nImplementation update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "Implementation update",
    });
    expect(parseThreadTextPrefix("[thread:main]\nGeneral note")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "General note",
    });
    expect(parseThreadTextPrefix("[thread:q-941] Same-line implementation update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "Same-line implementation update",
    });
    expect(parseThreadTextPrefix("[thread:main]\tSame-line main note")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "Same-line main note",
    });
    expect(parseThreadTextPrefix("[thread:main]")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "",
    });
  });

  it("strips only one separator after the text prefix", () => {
    // Preserve intentional leading whitespace in the displayed body after the
    // single routing separator has been consumed.
    expect(parseThreadTextPrefix("[thread:q-941]  Implementation update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: " Implementation update",
    });
    expect(parseThreadTextPrefix("[thread:main]\n\nGeneral note")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "\nGeneral note",
    });
    expect(parseThreadTextPrefix("[thread:main]\r\nGeneral note")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "General note",
    });
  });

  it("preserves established leading-whitespace tolerance before the marker", () => {
    expect(parseThreadTextPrefix("\n  [thread:q-941] Indented marker")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "Indented marker",
    });
  });

  it("reports missing or invalid text prefixes without guessing", () => {
    expect(parseThreadTextPrefix("No marker")).toMatchObject({ ok: false, reason: "missing" });
    expect(parseThreadTextPrefix("[thread:foo]\nNo route")).toMatchObject({
      ok: false,
      reason: "invalid",
      marker: "[thread:foo]",
    });
    expect(parseThreadTextPrefix("[thread:q-941]No separator")).toMatchObject({
      ok: false,
      reason: "invalid",
      marker: "[thread:q-941]",
    });
    expect(parseThreadTextPrefix("Prose before [thread:q-941] No route")).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });

  it("parses mid-message split markers at physical line start without requiring a separator", () => {
    // Mid-message route switches are gated by a preceding standalone divider,
    // so the marker parser only requires the marker to begin the physical line.
    // The ordinary first-line prefix parser remains stricter.
    expect(parseThreadTextPrefix("[thread:q-941]No separator")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(parseThreadTextLineStartMarker("[thread:q-941]No separator")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "No separator",
    });
    expect(parseThreadTextLineStartMarker("[thread:q-941:A:u1]No separator")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      role: "answer",
      answerUserMessageIds: ["u1"],
      body: "No separator",
    });
    expect(parseThreadTextLineStartMarker("> [thread:q-941] quoted")).toMatchObject({
      ok: false,
      reason: "missing",
    });
    expect(parseThreadTextLineStartMarker("  [thread:q-941] indented")).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });

  it("parses and strips command routing comments", () => {
    const command = "# thread:q-941\nrg -n thread web/src";

    expect(parseCommandThreadComment(command)).toEqual({ threadKey: "q-941", questId: "q-941" });
    expect(stripCommandThreadComment(command)).toBe("rg -n thread web/src");
    expect(parseCommandThreadComment("rg -n thread web/src")).toBeNull();
  });

  it("infers durable quest routes only from unambiguous text content", () => {
    // History replay can recover route metadata from durable leader prompts,
    // but only for clear single-target quest dispatches.
    expect(inferThreadTargetFromTextContent("Review [q-1009](quest:q-1009) in Code Review.")).toEqual({
      threadKey: "q-1009",
      questId: "q-1009",
    });
    expect(
      inferThreadTargetFromTextContent("Advance [q-1009](quest:q-1009) to Port.\n\nDo not include q-1010."),
    ).toEqual({
      threadKey: "q-1009",
      questId: "q-1009",
    });
    expect(
      inferThreadTargetFromTextContent(
        [
          "1 event from 1 session",
          "",
          "#1323 | turn_end | ✓ 1m 52s | tools: 29 | [350]-[414] | 1 user msg [350]",
          '[350] leader: "Review [q-1005](quest:q-1005) in the Outcome Review phase.',
          '[414] "ACCEPT: evidence shows `q-99` inserted after Main for [q-1005](quest:q-1005)."',
        ].join("\n"),
      ),
    ).toEqual({
      threadKey: "q-1005",
      questId: "q-1005",
    });
    expect(inferThreadTargetFromTextContent("Compare q-1009 with q-1010 before deciding.")).toBeNull();
    expect(
      inferThreadTargetFromTextContent(
        'Compare q-1008 with q-1009 first.\n[10] leader: "Review [q-1010](quest:q-1010)."',
      ),
    ).toBeNull();
  });
});
