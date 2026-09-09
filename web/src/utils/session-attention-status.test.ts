import { describe, expect, it } from "vitest";
import { hasUnreadSessionAttention, projectedSessionAttentionStatus } from "./session-attention-status.js";

it("separates unread review/errors from an unresolved needs-input prompt", () => {
  // Preserve the established error attention treatment while avoiding a false
  // unread result for prompts that deliberately survive session reading.
  expect(hasUnreadSessionAttention("review")).toBe(true);
  expect(hasUnreadSessionAttention("error")).toBe(true);
  expect(hasUnreadSessionAttention("action")).toBe(false);
  expect(hasUnreadSessionAttention(null)).toBe(false);
  expect(hasUnreadSessionAttention(undefined)).toBe(false);
});

const value = (
  attentionReason: "action" | "error" | "review" | null,
  urgency: "needs-input" | "review" | "muted-needs-input" | null,
  count = 1,
) => ({
  attentionReason,
  status: urgency ? { urgency, count } : null,
});

describe("projectedSessionAttentionStatus", () => {
  it("returns the accepted review status without consulting notification detail", () => {
    expect(projectedSessionAttentionStatus(value("review", "review"))).toEqual({ urgency: "review", count: 1 });
  });

  it("preserves the projected needs-input count", () => {
    expect(projectedSessionAttentionStatus(value("action", "needs-input", 3))).toEqual({
      urgency: "needs-input",
      count: 3,
    });
  });

  it("preserves muted needs-input while the unread reason remains clear", () => {
    expect(projectedSessionAttentionStatus(value(null, "muted-needs-input", 2))).toEqual({
      urgency: "muted-needs-input",
      count: 2,
    });
  });

  it("treats an explicit projected clear as no attention", () => {
    expect(projectedSessionAttentionStatus(value(null, null))).toBeNull();
  });

  it("fails closed while projection authority is absent", () => {
    expect(projectedSessionAttentionStatus(undefined)).toBeNull();
  });

  it("does not manufacture a marker for error-only attention", () => {
    expect(projectedSessionAttentionStatus(value("error", null))).toBeNull();
  });
});
