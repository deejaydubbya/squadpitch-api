// Data-aware autopilot service — preview-then-execute batch generation.
//
// NOT a background cron. The user triggers it, reviews suggestions, then executes.
// generateDraft / scheduleDraft are injected from the route handler to avoid circular imports.

import { getSmartOpportunities } from "./contentOpportunity.service.js";
import { getSmartBlueprintForItem } from "./dataAnalytics.service.js";
import { assignAngleBatch, pickAngleForSource } from "./contentAngles.js";

// ── Reasoning ────────────────────────────────────────────────────────

function buildReasoning(opp, angle) {
  const parts = [];
  if (opp.dataItem.usageCount === 0) {
    parts.push("Fresh content opportunity");
  }
  if (opp.adjustedScore >= 70) {
    parts.push("High opportunity score");
  } else if (opp.adjustedScore >= 50) {
    parts.push("Good opportunity score");
  }
  if (opp.dataItem.lastUsedAt) {
    const daysSince = Math.floor(
      (Date.now() - new Date(opp.dataItem.lastUsedAt).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    if (daysSince > 14) {
      parts.push(`Not used in ${daysSince}+ days`);
    }
  }
  if (angle) {
    parts.push(`Angle: ${angle.label}`);
  }
  if (parts.length === 0) parts.push("Selected by opportunity ranking");
  return parts.join(". ");
}

// ── Preview (read-only) ─────────────────────────────────────────────

export async function previewAutopilot(
  clientId,
  { count = 1, channel, excludeDataItemIds = [] } = {}
) {
  const opportunities = await getSmartOpportunities(clientId, {
    limit: count,
    channel,
    excludeDataItemIds,
  });

  // Assign diversified angles across the batch using shared angle system
  const angles = assignAngleBatch(opportunities.length);

  const suggestions = await Promise.all(
    opportunities.map(async (opp, index) => {
      const smartBp = await getSmartBlueprintForItem(
        opp.dataItem.id,
        clientId,
        { channel }
      );

      const blueprint = smartBp
        ? {
            id: smartBp.id,
            slug: smartBp.slug,
            name: smartBp.name,
            category: smartBp.category,
          }
        : opp.blueprint;

      const autoSelected = smartBp ? smartBp.id !== opp.blueprint.id : false;
      const angle = angles[index];

      return {
        rank: index + 1,
        dataItem: opp.dataItem,
        blueprint,
        opportunityScore: opp.score,
        adjustedScore: opp.adjustedScore,
        autoSelected,
        reasoning: buildReasoning(opp, angle),
        angle: angle?.key ?? null,
      };
    })
  );

  return { suggestions };
}

// ── Execute ─────────────────────────────────────────────────────────

export async function executeAutopilot(
  clientId,
  actorSub,
  {
    suggestions,
    channel,
    autoSchedule = false,
    generateDraft,
    scheduleDraft,
    checkUsageLimit,
    incrementUsage,
    userId,
  }
) {
  const results = [];
  // Re-assign angles for diversified generation guidance using shared angle system
  const angles = assignAngleBatch(suggestions.length);

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];
    const angle = angles[i];

    try {
      const allowed = await checkUsageLimit(userId, "posts");
      if (!allowed) {
        results.push({
          dataItemId: suggestion.dataItem.id,
          status: "limit_reached",
        });
        continue;
      }

      const draft = await generateDraft({
        clientId,
        kind: "POST",
        channel: channel || "INSTAGRAM",
        guidance: angle?.guidance ?? "",
        createdBy: actorSub,
        dataItemId: suggestion.dataItem.id,
        blueprintId: suggestion.blueprint.id,
        userId,
        contentAngle: angle,
      });

      await incrementUsage(userId, "posts");

      results.push({
        dataItemId: suggestion.dataItem.id,
        status: "success",
        draftId: draft.id,
      });
    } catch {
      results.push({
        dataItemId: suggestion.dataItem.id,
        status: "error",
      });
    }
  }

  // Auto-schedule: distribute across next 7 days at optimal hours, max 2/day
  let scheduledCount = 0;
  if (autoSchedule) {
    const OPTIMAL_HOURS = [9, 12, 15, 18];
    const now = new Date();
    const successDrafts = results.filter((r) => r.status === "success");

    for (let i = 0; i < successDrafts.length; i++) {
      const dayOffset = Math.floor(i / 2) + 1;
      const hourIdx = i % OPTIMAL_HOURS.length;

      const scheduledFor = new Date(now);
      scheduledFor.setDate(scheduledFor.getDate() + dayOffset);
      scheduledFor.setHours(OPTIMAL_HOURS[hourIdx], 0, 0, 0);

      try {
        await scheduleDraft(
          successDrafts[i].draftId,
          scheduledFor.toISOString(),
          actorSub
        );
        scheduledCount++;
      } catch {
        // Skip drafts that can't be scheduled
      }
    }
  }

  return {
    results,
    generated: results.filter((r) => r.status === "success").length,
    total: results.length,
    scheduled: scheduledCount,
  };
}
