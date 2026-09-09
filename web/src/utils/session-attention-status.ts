import type {
  SessionAttentionProjectionValue,
  SessionAttentionReason,
} from "../../shared/session-attention-projection.js";

export type EffectiveSessionAttentionStatus = NonNullable<SessionAttentionProjectionValue["status"]>;

/** Keep review/error unread treatment separate from the amber needs-input marker. */
export function hasUnreadSessionAttention(reason: SessionAttentionReason | undefined): boolean {
  return reason === "review" || reason === "error";
}

/** Current-build attention visuals fail closed until an accepted projection value exists. */
export function projectedSessionAttentionStatus(
  projection: SessionAttentionProjectionValue | undefined,
): EffectiveSessionAttentionStatus | null {
  return projection?.status ?? null;
}
