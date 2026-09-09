import { describe, expect, it } from "vitest";
import type { QuestmasterTask } from "../server/quest-types.js";
import { formatQuestDetail, formatQuestLine, type SessionMetadata } from "./quest-format.js";

describe("quest formatting", () => {
  const sessionMetadata = new Map<string, SessionMetadata>([
    ["worker-1", { archived: false, sessionNum: 12, name: "Worker session" }],
    ["leader-1", { archived: false, sessionNum: 3, name: "Leader session" }],
  ]);

  const quest = {
    id: "q-1",
    questId: "q-1",
    version: 2,
    title: "Orchestrated quest",
    status: "in_progress",
    description: "Ready",
    createdAt: Date.now(),
    statusChangedAt: Date.now(),
    sessionId: "worker-1",
    claimedAt: Date.now(),
    leaderSessionId: "leader-1",
  } satisfies QuestmasterTask;

  it("reveals expanded metadata details only when requested", () => {
    const compact = formatQuestDetail(quest, sessionMetadata);
    const detail = formatQuestDetail(quest, sessionMetadata, { sections: "metadata" });

    expect(compact).toContain('Session:     #12 "Worker session"');
    expect(compact).not.toContain("Metadata:");
    expect(detail).toContain('Session:     #12 "Worker session"');
    expect(detail).toContain('Leader:      #3 "Leader session"');
    expect(detail).toContain("Metadata:");
  });

  it("reveals compact delivery IDs for authoring without dumping retained review provenance", async () => {
    const { deliveryFixture } = await import("../src/test-fixtures/commit-delivery-fixture.js");
    const withDelivery = { ...quest, codeDeliveries: [deliveryFixture] };
    expect(formatQuestDetail(withDelivery, sessionMetadata)).not.toContain(deliveryFixture.id);
    const metadata = formatQuestDetail(withDelivery, sessionMetadata, { sections: "metadata" });
    expect(metadata).toContain(deliveryFixture.id);
    expect(metadata).toContain("quest commit-links q-1 --delivery <id>");
    expect(metadata).not.toContain("refs/takode");
    expect(metadata).not.toContain("/fixture/repo");
  });

  it("shows compact leader attribution in quest list output", () => {
    const line = formatQuestLine(quest, sessionMetadata);

    expect(line).toContain('[leader:"Leader session"');
  });

  it("keeps full phase bodies hidden in compact quest detail output", () => {
    const detail = formatQuestDetail({
      ...quest,
      journeyRuns: [
        {
          runId: "run-1",
          source: "board",
          phaseIds: ["alignment", "implement"],
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          phaseOccurrences: [
            {
              occurrenceId: "run-1:p1",
              phaseId: "alignment",
              phaseIndex: 0,
              phasePosition: 1,
              phaseOccurrence: 1,
              status: "completed",
            },
            {
              occurrenceId: "run-1:p2",
              phaseId: "implement",
              phaseIndex: 1,
              phasePosition: 2,
              phaseOccurrence: 1,
              status: "completed",
            },
          ],
        },
      ],
      feedback: [
        {
          author: "agent",
          kind: "phase_summary",
          text: "Full implementation detail that should stay behind the feedback-show drilldown.",
          tldr: "Implementation TLDR.",
          ts: Date.now(),
          journeyRunId: "run-1",
          phaseOccurrenceId: "run-1:p2",
          phaseId: "implement",
          phasePosition: 2,
        },
        { author: "human", text: "Flat follow-up stays visible.", ts: Date.now() },
      ],
    });

    expect(detail).toContain("Phase Documentation:");
    expect(detail).toContain("  Implement [phase 2]");
    expect(detail).toContain("TLDR: Implementation TLDR.");
    expect(detail).toContain("Reveal one full phase note with: quest show q-1 --sections phase:<index>");
    expect(detail).toContain("Unaddressed feedback:");
    expect(detail).toContain("#1 [human");
    expect(detail).not.toContain("Full implementation detail that should stay behind");
  });

  it("reveals description and debrief bodies through sections", () => {
    const detail = formatQuestDetail(
      {
        ...quest,
        status: "done",
        completedAt: Date.now(),
        verificationItems: [{ text: "Verify", checked: true }],
        description: "## Goal\n\n- Preserve Markdown-ish formatting.",
        debrief: "Final outcome body.\n\nSecond paragraph.",
        debriefTldr: "Final outcome TLDR.",
        journeyRuns: [
          {
            runId: "run-1",
            source: "board",
            phaseIds: ["implement"],
            status: "completed",
            createdAt: 1,
            updatedAt: 2,
            phaseOccurrences: [
              {
                occurrenceId: "run-1:p1",
                phaseId: "implement",
                phaseIndex: 0,
                phasePosition: 1,
                phaseOccurrence: 1,
                status: "completed",
              },
            ],
          },
        ],
        feedback: [
          {
            author: "agent",
            kind: "phase_summary",
            text: "Implementation detail.",
            tldr: "Implementation TLDR.",
            ts: Date.now(),
            phaseId: "implement",
            phasePosition: 1,
            phaseOccurrenceId: "run-1:p1",
            journeyRunId: "run-1",
          },
        ],
      },
      undefined,
      { sections: "description,debrief" },
    );

    const descriptionIndex = detail.indexOf("Description:\n  ## Goal\n  \n  - Preserve Markdown-ish formatting.");
    const debriefIndex = detail.indexOf("Debrief:\n  Final outcome body.\n  \n  Second paragraph.");
    const phaseIndex = detail.indexOf("Phase Documentation:");
    expect(descriptionIndex).toBeGreaterThanOrEqual(0);
    expect(debriefIndex).toBeGreaterThan(descriptionIndex);
    expect(phaseIndex).toBeGreaterThan(debriefIndex);
    expect(detail).toContain("Debrief TLDR:\n  Final outcome TLDR.");
  });

  it("reveals all phase TLDRs without full phase bodies through sections phases", () => {
    const detail = formatQuestDetail(
      {
        ...quest,
        journeyRuns: [
          {
            runId: "run-1",
            source: "board",
            phaseIds: ["implement"],
            status: "completed",
            createdAt: 1,
            updatedAt: 2,
            phaseOccurrences: [
              {
                occurrenceId: "run-1:p1",
                phaseId: "implement",
                phaseIndex: 0,
                phasePosition: 1,
                phaseOccurrence: 1,
                status: "completed",
              },
              {
                occurrenceId: "run-1:p2",
                phaseId: "implement",
                phaseIndex: 1,
                phasePosition: 2,
                phaseOccurrence: 2,
                status: "completed",
              },
            ],
          },
        ],
        feedback: [
          {
            author: "agent",
            kind: "phase_summary",
            text: "First implementation body should stay hidden.",
            tldr: "First implementation TLDR.",
            ts: Date.now(),
            phaseId: "implement",
            phasePosition: 1,
            phaseOccurrence: 1,
            phaseOccurrenceId: "run-1:p1",
            journeyRunId: "run-1",
          },
          {
            author: "agent",
            kind: "phase_summary",
            text: "Repeated implementation body should stay hidden.",
            tldr: "Repeated implementation TLDR.",
            ts: Date.now(),
            phaseId: "implement",
            phasePosition: 2,
            phaseOccurrence: 2,
            phaseOccurrenceId: "run-1:p2",
            journeyRunId: "run-1",
          },
        ],
      },
      undefined,
      { sections: "phases" },
    );

    expect(detail).toContain("  Implement [phase 1]");
    expect(detail).toContain("  Implement #2 [phase 2]");
    expect(detail).toContain("TLDR: First implementation TLDR.");
    expect(detail).toContain("TLDR: Repeated implementation TLDR.");
    expect(detail).not.toContain("First implementation body should stay hidden");
    expect(detail).not.toContain("Repeated implementation body should stay hidden");
  });

  it("reveals exactly one full phase note through phase index", () => {
    const detail = formatQuestDetail(
      {
        ...quest,
        journeyRuns: [
          {
            runId: "run-1",
            source: "board",
            phaseIds: ["alignment", "implement"],
            status: "completed",
            createdAt: 1,
            updatedAt: 2,
            phaseOccurrences: [
              {
                occurrenceId: "run-1:p1",
                phaseId: "alignment",
                phaseIndex: 0,
                phasePosition: 1,
                phaseOccurrence: 1,
                status: "completed",
              },
              {
                occurrenceId: "run-1:p2",
                phaseId: "implement",
                phaseIndex: 1,
                phasePosition: 2,
                phaseOccurrence: 1,
                status: "completed",
              },
            ],
          },
        ],
        feedback: [
          {
            author: "agent",
            kind: "phase_summary",
            text: "Alignment body remains hidden.",
            tldr: "Alignment TLDR.",
            ts: Date.now(),
            phaseId: "alignment",
            phasePosition: 1,
            phaseOccurrenceId: "run-1:p1",
            journeyRunId: "run-1",
          },
          {
            author: "agent",
            kind: "phase_summary",
            text: "Implementation body is revealed.\n\n- With Markdown-ish list.",
            tldr: "Implementation TLDR.",
            ts: Date.now(),
            phaseId: "implement",
            phasePosition: 2,
            phaseOccurrenceId: "run-1:p2",
            journeyRunId: "run-1",
          },
        ],
      },
      undefined,
      { sections: "phase:1" },
    );

    expect(detail).toContain("Phase #1: Implement [phase 2]");
    expect(detail).toContain("  Body:\n    Implementation body is revealed.\n    \n    - With Markdown-ish list.");
    expect(detail).not.toContain("Alignment body remains hidden.");
  });

  it("omits large hidden bodies from compact default output and keeps full available", () => {
    const largeBody = "VERY_LARGE_BODY ".repeat(80);
    const compact = formatQuestDetail({
      ...quest,
      description: largeBody,
      feedback: [{ author: "agent", kind: "phase_summary", text: largeBody, ts: Date.now(), phaseId: "implement" }],
    });
    const full = formatQuestDetail(
      {
        ...quest,
        description: largeBody,
        feedback: [{ author: "agent", kind: "phase_summary", text: largeBody, ts: Date.now(), phaseId: "implement" }],
      },
      undefined,
      { full: true },
    );

    expect(compact).not.toContain(largeBody);
    expect(compact).toContain("Full detail: quest show q-1 --full");
    expect(full).toContain("Warning: --full can consume substantial context.");
    expect(full).toContain(largeBody);
  });
});
