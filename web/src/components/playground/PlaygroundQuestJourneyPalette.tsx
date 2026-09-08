import {
  getQuestJourneyPhase,
  type ActiveQuestJourneyPhaseId,
  type QuestJourneyPlanState,
  type QuestJourneyState,
} from "../../../shared/quest-journey.js";
import { getQuestPhaseDotStyle, getQuestPhaseTextStyle } from "../../utils/quest-phase-theme.js";
import { QuestJourneyPreviewCard, QuestJourneyTimeline } from "../QuestJourneyTimeline.js";

const ACTIVE_PHASE_PALETTE: Array<{
  id: ActiveQuestJourneyPhaseId;
  status: QuestJourneyState;
  description: string;
}> = [
  { id: "alignment", status: "PLANNING", description: "Sky/cyan read-in" },
  { id: "work", status: "WORKING", description: "Existing green execution" },
  { id: "user-checkpoint", status: "USER_CHECKPOINTING", description: "Amber decision pause" },
  { id: "memory", status: "MEMORY", description: "Violet durable closure" },
];

const PROPOSED_JOURNEY: QuestJourneyPlanState = {
  mode: "proposed",
  phaseIds: ["alignment", "work", "user-checkpoint", "work", "memory"],
  phaseNotes: { "2": "Confirm the delivery choice before Work resumes." },
};

export function PlaygroundQuestJourneyPalette() {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="playground-v2-phase-palette">
      {ACTIVE_PHASE_PALETTE.map(({ id, status, description }) => {
        const phase = getQuestJourneyPhase(id);
        if (!phase) return null;
        return (
          <div
            key={id}
            className="min-w-0 rounded-md border border-cc-border bg-cc-bg/60 p-2.5"
            data-testid={`playground-v2-phase-${id}`}
            data-phase-color={phase.color.name}
          >
            <div className="mb-2 flex min-w-0 items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                style={getQuestPhaseDotStyle(phase)}
                data-testid={`playground-v2-phase-${id}-accent`}
                aria-hidden="true"
              />
              <span
                className="min-w-0 truncate text-xs font-semibold"
                style={getQuestPhaseTextStyle(phase)}
                data-testid={`playground-v2-phase-${id}-text`}
              >
                {phase.label}
              </span>
            </div>
            <QuestJourneyTimeline
              compact
              journey={{ mode: "active", phaseIds: [id], activePhaseIndex: 0, currentPhaseId: id }}
              status={status}
            />
            <p className="mt-1.5 text-[10px] text-cc-muted">{description}</p>
          </div>
        );
      })}
      <div
        className="min-w-0 rounded-md border border-cc-border bg-cc-bg/60 p-2.5 sm:col-span-2 xl:col-span-4"
        data-testid="playground-proposed-journey-summary"
      >
        <p className="mb-2 text-xs font-semibold">Proposed Journey summary</p>
        <QuestJourneyTimeline compact journey={PROPOSED_JOURNEY} status="PROPOSED" />
        <details className="mt-2 max-w-md text-xs">
          <summary className="cursor-pointer text-cc-muted">Full Journey</summary>
          <QuestJourneyPreviewCard journey={PROPOSED_JOURNEY} status="PROPOSED" className="mt-2" />
        </details>
      </div>
    </div>
  );
}
