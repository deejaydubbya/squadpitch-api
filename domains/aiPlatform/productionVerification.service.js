import { generateCampaignOpsAgentPreview } from "./campaignOpsAgent.service.js";
import { generateDraftContentProposalDryRun } from "./aiActionProposal.service.js";
import { rankAutopilotOpportunities } from "./autopilotMlRanking.service.js";
import { scoreBrandContentQuality } from "./brandQualityModel.service.js";
import { queryWorkspaceRetrieval } from "./retrievalQuery.service.js";

const VERIFY_ACTOR = Object.freeze({
  auth0Sub: "system:ai-production-verification",
  id: "system:ai-production-verification",
});

const allowReadOnlyVerification = async () => ({ allowed: true });

function candidate(workspaceId, candidateId, heuristicScore) {
  return {
    candidateId,
    workspaceId,
    triggerType: "NEW_LISTING",
    industry: "real_estate",
    channel: "INSTAGRAM",
    heuristicScore,
    listingAgeDays: 4,
    priceChangePercent: 0,
    daysSinceLastPost: 8,
    mediaAvailable: true,
    historicalApprovalRate: 0.7,
    historicalEngagementRate: 0.03,
    hourOfDay: 10,
    dayOfWeek: 2,
    contentType: "listing",
    recentAudienceEngagement: 0.04,
    detectedAt: new Date().toISOString(),
  };
}

export function productionVerificationOperations({
  campaignOps = generateCampaignOpsAgentPreview,
  autopilot = rankAutopilotOpportunities,
  brandQuality = scoreBrandContentQuality,
  retrieval = queryWorkspaceRetrieval,
  actionProposal = generateDraftContentProposalDryRun,
} = {}) {
  return [
    {
      key: "campaign_ops",
      name: "Campaign Ops",
      execute: async (workspaceId, traceId) => {
        const objective =
          "Create a safe read-only campaign plan with professional, locally informed market guidance.";
        const result = await campaignOps({
          actor: VERIFY_ACTOR,
          workspaceId,
          objective,
          traceId,
          featureEnabled: true,
          authorizationService: allowReadOnlyVerification,
          featureFlagEvaluator: async () => true,
          subscriptionFetcher: async () => ({ status: "ACTIVE", tier: "PRO" }),
          effectiveTierResolver: () => "PRO",
          retrievalPlatformEnabled: true,
          retrievalFeatureEnabled: true,
          snapshotBuilder: async () => ({
            workspaceId,
            objective,
            items: [
              {
                sourceType: "brand_profile",
                sourceId: "production-verification-brand",
                title: "Verification brand context",
                text: "Professional, accurate, locally informed market guidance.",
                contentHash:
                  "sha256:912a117e4b58614b578a1f83b5e119ac80fe16a8402e3897af17223e346e32a1",
                trust: "approved",
                language: "en",
              },
            ],
            media: [],
            calendar: [],
            approvalPolicy: { requiresHumanApproval: true },
            allowedChannels: ["INSTAGRAM"],
          }),
        });
        return {
          usableResult:
            result?.status === "proposal_only" &&
            result?.proposal?.proposalOnly === true &&
            Array.isArray(result?.proposal?.proposedPosts),
          provenance: result?.provenance,
        };
      },
    },
    {
      key: "retrieval",
      name: "Retrieval",
      execute: async (workspaceId, traceId) => {
        const result = await retrieval({
          actor: VERIFY_ACTOR,
          workspaceId,
          query: "professional local market guidance",
          purpose: "verification",
          topK: 3,
          traceId,
          platformEnabled: true,
          retrievalEnabled: true,
          authorizationService: allowReadOnlyVerification,
          featureFlagEvaluator: async () => true,
          snapshotItems: [
            {
              sourceType: "brand_profile",
              sourceId: "production-verification-brand",
              title: "Verification brand context",
              text: "Professional, accurate, locally informed market guidance.",
              contentHash:
                "sha256:912a117e4b58614b578a1f83b5e119ac80fe16a8402e3897af17223e346e32a1",
              trust: "approved",
              language: "en",
            },
          ],
        });
        return {
          usableResult:
            result?.workspaceId === workspaceId &&
            Array.isArray(result?.results) &&
            result.results.every(
              (item) => item?.citation?.workspaceId === workspaceId,
            ),
          provenance: result?.provenance,
        };
      },
    },
    {
      key: "action_proposal",
      name: "Action Proposal",
      execute: async (workspaceId, traceId) => {
        const objective =
          "Draft an Instagram listing post for 123 Verification Avenue using approved property facts.";
        const result = await actionProposal({
          actor: VERIFY_ACTOR,
          workspaceId,
          objective,
          requestedChannels: ["INSTAGRAM"],
          idempotencyKey: `production-verification:${traceId}`,
          traceId,
          featureEnabled: true,
          authorizationService: allowReadOnlyVerification,
          featureFlagEvaluator: async () => true,
          subscriptionFetcher: async () => ({ status: "ACTIVE", tier: "PRO" }),
          effectiveTierResolver: () => "PRO",
          snapshotBuilder: async () => ({
            workspaceId,
            objective,
            items: [
              {
                sourceType: "property_listing",
                sourceId: "production-verification-property",
                title: "123 Verification Avenue",
                text: "123 Verification Avenue is listed for $425,000 with 3 bedrooms and 2 bathrooms.",
                contentHash:
                  "sha256:9dd0aa0d083244ceeb89a4c3c25fef9d2921daeb08f34ece307f69e2c5a4a81a",
                trust: "authoritative",
                language: "en",
              },
            ],
            media: [],
            calendar: [],
            approvalPolicy: { requiresHumanApproval: true },
            allowedChannels: ["INSTAGRAM"],
          }),
        });
        return {
          usableResult:
            result?.status === "dry_run" &&
            result?.dryRun === true &&
            result?.persistence === false &&
            result?.proposal?.proposalOnly === true &&
            result?.proposal?.proposalType === "draft_content" &&
            result?.proposal?.workspaceId === workspaceId,
          provenance: result?.provenance,
          diagnostics: {
            workspaceId,
            proposalType: result?.proposal?.proposalType ?? null,
            schemaVersion: result?.proposal?.schemaVersion ?? null,
            dryRun: result?.dryRun === true,
            persistence: result?.persistence === true,
          },
        };
      },
    },
    {
      key: "autopilot_ranking",
      name: "Autopilot Ranking",
      execute: async (workspaceId) => {
        const result = await autopilot({
          actor: VERIFY_ACTOR,
          workspaceId,
          candidates: [
            candidate(workspaceId, "verification-candidate-a", 0.8),
            candidate(workspaceId, "verification-candidate-b", 0.4),
          ],
          shadowMode: false,
          featureEnabled: true,
          authorizationService: allowReadOnlyVerification,
          featureFlagEvaluator: async () => true,
        });
        return {
          usableResult:
            Array.isArray(result?.rankedCandidates) &&
            result.rankedCandidates.length === 2,
          provenance: result?.provenance,
        };
      },
    },
    {
      key: "brand_quality",
      name: "Brand Quality",
      execute: async (workspaceId) => {
        const result = await brandQuality({
          actor: VERIFY_ACTOR,
          workspaceId,
          contentId: "production-verification-content",
          sanitizedText:
            "A professional market update using verified facts and a clear invitation to learn more.",
          channel: "INSTAGRAM",
          industry: "real_estate",
          brandConstraints: ["professional", "accurate", "helpful"],
          bannedPhrases: ["guaranteed profit"],
          language: "en",
          featureEnabled: true,
          authorizationService: allowReadOnlyVerification,
          featureFlagEvaluator: async () => true,
        });
        return {
          usableResult:
            result?.qualityScore?.proposalOnly === true &&
            Array.isArray(result?.qualityScore?.scores),
          provenance: result?.provenance,
        };
      },
    },
  ];
}

export async function runProductionAiVerification({
  workspaceId,
  requestTraceId,
  operations = productionVerificationOperations(),
} = {}) {
  const results = [];
  for (const operation of operations) {
    const startedAt = Date.now();
    try {
      const result = await operation.execute(
        workspaceId,
        `${requestTraceId}:${operation.key}`,
      );
      results.push({
        operation: operation.key,
        name: operation.name,
        usableResult: result?.usableResult === true,
        provenance: result?.provenance ?? null,
        diagnostics: result?.diagnostics ?? null,
        latencyMs: Date.now() - startedAt,
        message:
          result?.usableResult === true
            ? null
            : "Operation returned an unusable result",
      });
    } catch (error) {
      results.push({
        operation: operation.key,
        name: operation.name,
        usableResult: false,
        provenance: null,
        latencyMs: Date.now() - startedAt,
        message: safeErrorMessage(error),
      });
    }
  }
  return {
    environment: process.env.NODE_ENV ?? "unknown",
    generatedAt: new Date().toISOString(),
    results,
    skipped: [],
  };
}

function safeErrorMessage(error) {
  const code =
    typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : "OPERATION_FAILED";
  return `Operation failed (${code})`;
}
