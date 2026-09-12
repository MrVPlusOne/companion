import { useMemo, useState } from "react";
import { QuestCommitChip } from "../QuestCommitChip.js";
import { Card, Section, PlaygroundSectionGroup } from "./shared.js";
import {
  createDeliveryFixtureClient,
  deliveryFixture,
  laterDeliveryFixture,
  legacyDeliveryFixture,
  DELIVERY_FIXTURE_QUEST,
} from "../../test-fixtures/commit-delivery-fixture.js";

export function PlaygroundCommitDeliverySection() {
  const [later, setLater] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const client = useMemo(() => createDeliveryFixtureClient(unavailable), [unavailable]);
  return (
    <PlaygroundSectionGroup groupId="overview">
      <Section
        title="Commit delivery chips"
        description="Current batches retain exact commits with explicit parent/merge/root comparisons, preserved legacy counts, and separate review history."
      >
        <Card label="Recorded delivery responses">
          <div className="space-y-3">
            <div className="rounded border border-cc-border p-3 text-sm text-cc-fg">
              <div className="font-medium">Pending port</div>
              <p className="text-xs text-cc-muted">
                Preview: refine the loading state. Source commits are not recorded delivery evidence until landing is
                verified.
              </p>
            </div>
            <p className="text-sm text-cc-fg">
              Earlier delivered batch. These links keep their original commits when a new batch arrives.
            </p>
            <span className="commit-chip-group" role="group" aria-label="First delivery commits">
              {deliveryFixture.commits.map((commit) => (
                <QuestCommitChip
                  key={commit.sha}
                  questId={DELIVERY_FIXTURE_QUEST}
                  deliveryId={deliveryFixture.id}
                  sha={commit.sha}
                  client={client}
                >
                  {commit.message}
                </QuestCommitChip>
              ))}
            </span>
            <div>
              <p className="mb-2 text-sm text-cc-fg">A separate short commit sizes to its own content.</p>
              <span className="commit-chip-group" role="group" aria-label="Single commit">
                <QuestCommitChip
                  questId={DELIVERY_FIXTURE_QUEST}
                  deliveryId={laterDeliveryFixture.id}
                  sha={laterDeliveryFixture.commits[0]!.sha}
                  client={client}
                >
                  Later fix
                </QuestCommitChip>
              </span>
            </div>
            {later && (
              <div className="border-t border-cc-border pt-3">
                <p className="mb-2 text-sm text-cc-fg">
                  Newly delivered batch: only the empty-state fix is introduced here.
                </p>
                <QuestCommitChip
                  questId={DELIVERY_FIXTURE_QUEST}
                  deliveryId={laterDeliveryFixture.id}
                  sha={laterDeliveryFixture.commits[0]!.sha}
                  client={client}
                >
                  Later fix
                </QuestCommitChip>
              </div>
            )}
            <div>
              <p className="mb-2 text-sm text-cc-fg">
                Historical evidence keeps its saved counts; an unrecorded baseline stays explicit.
              </p>
              <QuestCommitChip
                questId={DELIVERY_FIXTURE_QUEST}
                deliveryId={legacyDeliveryFixture.id}
                sha={legacyDeliveryFixture.commits[0]!.sha}
                client={client}
              >
                Older saved commit
              </QuestCommitChip>
            </div>
            <div className="flex flex-wrap gap-2 pt-3 text-xs">
              <button
                type="button"
                className="rounded border border-cc-border px-3 py-2"
                onClick={() => setLater((value) => !value)}
              >
                {later ? "Hide later delivery" : "Add later delivery"}
              </button>
              <button
                type="button"
                className="rounded border border-cc-border px-3 py-2"
                onClick={() => setUnavailable((value) => !value)}
              >
                {unavailable ? "Restore repository" : "Make repository unavailable"}
              </button>
            </div>
            <p className="text-xs text-cc-muted">
              Synthetic server-shaped fixtures. Full numeric counts and titles remain in each chip’s accessible label
              and tooltip. Review evidence does not add delivered commits.
            </p>
          </div>
        </Card>
      </Section>
    </PlaygroundSectionGroup>
  );
}
