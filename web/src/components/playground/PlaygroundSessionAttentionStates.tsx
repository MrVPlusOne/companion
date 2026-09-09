import { useEffect, useState } from "react";
import {
  SESSION_ATTENTION_PROJECTION,
  type SessionAttentionProjectionValue as Value,
} from "../../../shared/session-attention-projection.js";
import { useStore } from "../../store.js";
import { hasUnreadSessionAttention } from "../../utils/session-attention-status.js";
import { SessionHoverCard } from "../SessionHoverCard.js";
import { SessionItem, StatusCountDots } from "../SessionItem.js";
import { PLAYGROUND_SESSION_ROWS } from "./fixtures.js";
import { Section } from "./shared.js";

const base = PLAYGROUND_SESSION_ROWS[3].session;
type Reason = Value["attentionReason"];
type Urgency = NonNullable<Value["status"]>["urgency"];
type Demo = [string, string, Reason, Urgency | null, number?, number?, number?];
const DEMOS: Demo[] = [
  ["timer", "Idle + timer", null, null, 1],
  ["needs-input", "Needs input > timer", "action", "needs-input", 1, 0, 2],
  ["review", "Review (hover count)", "review", "review", 0, 0, 3],
  ["muted", "Muted needs input", null, "muted-needs-input", 1],
  ["cleared", "Cleared to idle", null, null],
  ["permission", "Permission > attention", "action", "needs-input", 1, 2, 2],
  ["error", "Error attention", "error", null, 1],
  ["leader-checkpoint", "Read leader + checkpoint", "action", "needs-input"],
];
const value = ([, , attentionReason, urgency, , , count = 1]: Demo): Value => ({
  attentionReason,
  status: urgency ? { urgency, count } : null,
});
const session = ([slug, , , , pendingTimerCount = 0, permCount = 0]: Demo, index: number) => ({
  ...base,
  id: `playground-projected-${slug}`,
  sessionNum: 2101 + index,
  createdAt: Date.now() - (index + 1) * 60_000,
  pendingTimerCount,
  permCount,
  isOrchestrator: slug === "leader-checkpoint",
  leaderProfilePortrait:
    slug === "leader-checkpoint" ? PLAYGROUND_SESSION_ROWS[0].session.leaderProfilePortrait : undefined,
});
const sessions = DEMOS.map(session);
const reviewed = sessions[4];
const reviewerDemo: Demo = ["reviewer", "Reviewer", "review", "review"];
const reviewer = {
  ...session(reviewerDemo, 8),
  reviewerOf: reviewed.sessionNum,
};
const SEEDED = DEMOS.map((demo, index) => ({
  session: sessions[index],
  value: value(demo),
}));
SEEDED.push({ session: reviewer, value: value(reviewerDemo) });
const aggregateCounts = { running: 1, permission: 1, unread: 1, waiting: 1 };
const noop = () => {};
const itemProps = {
  isActive: false,
  isRecentlyRenamed: false,
  onSelect: noop,
  onStartRename: noop,
  onArchive: noop,
  onUnarchive: noop,
  onDelete: noop,
  onClearRecentlyRenamed: noop,
  editingSessionId: null,
  editingName: "",
  setEditingName: noop,
  onConfirmRename: noop,
  onCancelRename: noop,
  editInputRef: { current: null },
};

type Hover = { session: typeof reviewed; rect: DOMRect };
export function PlaygroundSessionAttentionStates() {
  const reasons = useStore((state) => state.sessionAttention);
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => {
    const store = useStore.getState();
    for (const { session, value } of SEEDED)
      store.applySyncedProjectionSnapshot({
        type: "synced_projection_snapshot",
        projection: SESSION_ATTENTION_PROJECTION,
        key: session.id,
        generation: "playground-session-attention",
        revision: 1,
        value,
      });
    const clear = store.clearSyncedProjectionKey;
    return () => SEEDED.forEach(({ session }) => clear(SESSION_ATTENTION_PROJECTION, session.id));
  }, []);
  return (
    <Section
      title="Session Attention Projection"
      description="Read results clear blue; unresolved prompts retain amber. Hover for the projected count."
    >
      <div className="rounded-xl bg-cc-sidebar p-2">
        <div className="flex items-center gap-2 px-2 pb-1 text-[10px] text-cc-muted">
          Reviewer + tree aggregate
          <StatusCountDots counts={aggregateCounts} />
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {DEMOS.map((demo, index) => {
            const [slug, label] = demo;
            const current = sessions[index];
            return (
              <SessionItem
                key={slug}
                {...itemProps}
                session={current}
                sessionName={label}
                permCount={current.permCount}
                attention={reasons.get(current.id) ?? null}
                hasUnread={hasUnreadSessionAttention(reasons.get(current.id))}
                onHoverStart={(_, rect) => setHover({ session: current, rect })}
                onHoverEnd={() => setHover(null)}
                reviewerSession={current === reviewed ? reviewer : undefined}
                compact={!current.isOrchestrator}
              />
            );
          })}
        </div>
      </div>
      {hover && (
        <SessionHoverCard
          session={hover.session}
          sessionName="Projected attention"
          sessionPreview="The hover count comes from the same projection."
          taskHistory={undefined}
          anchorRect={hover.rect}
          onMouseEnter={noop}
          onMouseLeave={() => setHover(null)}
        />
      )}
    </Section>
  );
}
