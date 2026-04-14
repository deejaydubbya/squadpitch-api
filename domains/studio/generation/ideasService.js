// Content Ideas Engine — generates 10 categorized content ideas for a client.

import { loadClientGenerationContext } from "./clientOrchestrator.js";
import { buildSystemPrompt } from "./promptBuilder.js";
import { generateStructuredContent } from "./openai.provider.js";
import { trackAiUsage } from "../../billing/aiUsageTracking.service.js";
import { prisma } from "../../../prisma.js";

const IDEAS_OUTPUT_SCHEMA = {
  name: "content_ideas",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ideas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "Short punchy title for the idea." },
            category: { type: "string", description: "Category: educational, promotional, storytelling, engagement, or trending." },
            description: { type: "string", description: "1-2 sentence description of the post idea." },
            suggestedChannel: { type: "string", description: "Best platform for this idea." },
          },
          required: ["title", "category", "description", "suggestedChannel"],
        },
        description: "Array of 10 content ideas.",
      },
    },
    required: ["ideas"],
  },
};

export async function generateContentIdeas(clientId, { userId } = {}) {
  const ctx = await loadClientGenerationContext(clientId);
  const systemPrompt = buildSystemPrompt(ctx);

  // Fetch available data item types so ideas reference actual business data
  const dataItemCounts = await prisma.workspaceDataItem.groupBy({
    by: ["type"],
    where: { clientId },
    _count: true,
  }).catch(() => []);

  const promptParts = [];
  promptParts.push(`Generate 10 diverse content ideas for this brand's social media. Each idea should be:
- Specific and actionable (not generic)
- Varied across categories: educational, promotional, storytelling, engagement, trending
- Appropriate for the brand's voice and audience
- Ready to be turned into a post with one click`);

  // Inject industry context
  const industry = ctx.industryContext;
  if (industry) {
    promptParts.push(`\nThis is a ${industry.label} business. Tailor ideas to this industry's audience and content traditions.`);
    if (industry.contentAngles?.length > 0) {
      promptParts.push(`Industry-proven angles to draw from:`);
      industry.contentAngles.forEach((a) => promptParts.push(`- ${a}`));
    }
  }

  // Inject available data item types
  if (dataItemCounts.length > 0) {
    const summary = dataItemCounts
      .map((r) => `${r.type.replace(/_/g, " ")}: ${r._count}`)
      .join(", ");
    promptParts.push(`\nAvailable business data the user has uploaded: ${summary}`);
    promptParts.push(`At least 3 ideas should reference this existing data (e.g. "Share one of your ${dataItemCounts[0]?.type.replace(/_/g, " ").toLowerCase()}s").`);
  }

  promptParts.push(`\nConsider current social media trends, the brand's industry, and their target audience.
Suggest the best platform for each idea (Instagram, TikTok, LinkedIn, X, Facebook, or YouTube).

Respond with JSON matching the content_ideas schema.`);

  const userPrompt = promptParts.join("\n");

  const responseFormat = { type: "json_schema", json_schema: IDEAS_OUTPUT_SCHEMA };

  const result = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    responseFormat,
    taskType: "lightweight",
    temperature: 0.9,
  });

  // Fire-and-forget: track AI usage
  if (userId) {
    trackAiUsage({
      userId,
      clientId,
      actionType: "IDEAS",
      model: result.model,
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
    });
  }

  const parsed = result.parsed;
  return Array.isArray(parsed?.ideas) ? parsed.ideas : [];
}
