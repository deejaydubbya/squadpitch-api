// Content Ideas Engine — generates 10 categorized content ideas for a client.

import { loadClientGenerationContext } from "./clientOrchestrator.js";
import { buildSystemPrompt } from "./promptBuilder.js";
import { generateStructuredContent } from "./openai.provider.js";

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

export async function generateContentIdeas(clientId) {
  const ctx = await loadClientGenerationContext(clientId);
  const systemPrompt = buildSystemPrompt(ctx);

  const userPrompt = `Generate 10 diverse content ideas for this brand's social media. Each idea should be:
- Specific and actionable (not generic)
- Varied across categories: educational, promotional, storytelling, engagement, trending
- Appropriate for the brand's voice and audience
- Ready to be turned into a post with one click

Consider current social media trends, the brand's industry, and their target audience.
Suggest the best platform for each idea (Instagram, TikTok, LinkedIn, X, Facebook, or YouTube).

Respond with JSON matching the content_ideas schema.`;

  const responseFormat = { type: "json_schema", json_schema: IDEAS_OUTPUT_SCHEMA };

  const result = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    responseFormat,
    temperature: 0.9,
  });

  const parsed = result.parsed;
  return Array.isArray(parsed?.ideas) ? parsed.ideas : [];
}
