import type { ModelProvenanceMigration } from "../../types.js";
import { ChatView } from "../ChatView.js";
import { ModelProvenanceMigrationBanner } from "../ModelProvenanceMigrationBanner.js";
import {
  PLAYGROUND_BROKEN_SESSION_ID,
  PLAYGROUND_DISCONNECTED_SESSION_ID,
  PLAYGROUND_RECOVERING_SESSION_ID,
  PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID,
  PLAYGROUND_RESUMING_SESSION_ID,
  PLAYGROUND_STARTING_SESSION_ID,
  PLAYGROUND_STREAM_RETRY_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_ACTIVE_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_PENDING_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_RECOVERING_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_REPLAY_SESSION_ID,
} from "./fixtures.js";
import { Card, Section } from "./shared.js";

const PLAYGROUND_MODEL_PROVENANCE_MIGRATION: ModelProvenanceMigration = {
  eventId: "model-provenance-migration:playground",
  code: "model_provenance_unavailable",
  source: "legacy_relaunch",
  selectedModel: "gpt-5.6-sol",
  authority: {
    model: "gpt-5.6-sol",
    source: "session_default",
    policyVersion: "playground",
    overrideTrace: [
      {
        model: "gpt-5.6-sol",
        source: "session_default",
        precedence: 300,
        status: "selected",
      },
    ],
  },
  migratedAt: 0,
  warning: "Original model provenance was unavailable. Takode selected gpt-5.6-sol and persisted this exact choice.",
};

function ChatStateCard({ label, sessionId, testId }: { label: string; sessionId: string; testId?: string }) {
  return (
    <Card label={label}>
      <div data-testid={testId} className="h-[260px] overflow-hidden rounded-xl border border-cc-border bg-cc-card">
        <ChatView sessionId={sessionId} />
      </div>
    </Card>
  );
}

export function PlaygroundChatViewRecoveryStates() {
  return (
    <Section
      title="ChatView Recovery States"
      description="Interrupted-work recovery stays distinct from session reconnect status. Takode may replay proven-absent input once or run one follow-up without repeating completed actions, while terminal recovery remains auditable without a user-attention chip."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ChatStateCard
          label="Interrupted work: reconnecting"
          sessionId={PLAYGROUND_TURN_RECOVERY_RECOVERING_SESSION_ID}
          testId="playground-codex-turn-recovery-recovering"
        />
        <ChatStateCard
          label="Interrupted work: proven-absent replay"
          sessionId={PLAYGROUND_TURN_RECOVERY_REPLAY_SESSION_ID}
          testId="playground-codex-turn-recovery-replay"
        />
        <ChatStateCard
          label="Interrupted work: follow-up queued"
          sessionId={PLAYGROUND_TURN_RECOVERY_PENDING_SESSION_ID}
          testId="playground-codex-turn-recovery-continuation-pending"
        />
        <ChatStateCard
          label="Interrupted work: finishing"
          sessionId={PLAYGROUND_TURN_RECOVERY_ACTIVE_SESSION_ID}
          testId="playground-codex-turn-recovery-continuation-active"
        />
        <ChatStateCard
          label="Interrupted work: audit retained, attention hidden"
          sessionId={PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID}
          testId="playground-codex-turn-recovery-action-required"
        />
        <ChatStateCard label="Fresh session starting" sessionId={PLAYGROUND_STARTING_SESSION_ID} />
        <ChatStateCard label="Message retry + reconnecting chips" sessionId={PLAYGROUND_RECOVERING_SESSION_ID} />
        <ChatStateCard
          label="Codex-reported response retry"
          sessionId={PLAYGROUND_STREAM_RETRY_SESSION_ID}
          testId="playground-codex-stream-retry"
        />
        <ChatStateCard label="Recoverable resuming chip" sessionId={PLAYGROUND_RESUMING_SESSION_ID} />
        <ChatStateCard label="Recoverable disconnected chip" sessionId={PLAYGROUND_DISCONNECTED_SESSION_ID} />
        <ChatStateCard label="Broken session relaunch banner" sessionId={PLAYGROUND_BROKEN_SESSION_ID} />
        <ChatStateCard label="Automatic recovery suppressed" sessionId={PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID} />
        <Card label="Compact migration notice">
          <ModelProvenanceMigrationBanner
            migration={PLAYGROUND_MODEL_PROVENANCE_MIGRATION}
            onAcknowledge={async () => {}}
          />
        </Card>
        <Card label="Expanded migration details">
          <ModelProvenanceMigrationBanner
            migration={PLAYGROUND_MODEL_PROVENANCE_MIGRATION}
            defaultDetailsOpen
            onAcknowledge={async () => {}}
          />
        </Card>
        <Card label="Acknowledged migration hidden">
          <div data-testid="playground-acknowledged-migration-hidden" className="min-h-8">
            <ModelProvenanceMigrationBanner
              migration={{ ...PLAYGROUND_MODEL_PROVENANCE_MIGRATION, acknowledgedAt: 1 }}
              onAcknowledge={async () => {}}
            />
          </div>
        </Card>
      </div>
    </Section>
  );
}
