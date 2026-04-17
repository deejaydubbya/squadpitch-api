// AI Model Router — central config for task-type → model mapping with cost metadata.

const MODEL_COSTS = {
  "gpt-4o-mini": { inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  "gpt-4o": { inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
};

// Fal.ai models use fixed per-call pricing (no token counts).
const FAL_MODEL_COSTS = {
  "fal-ai/flux/dev": 2.5,
  "fal-ai/flux-lora": 3.0,
  "fal-ai/kling-video/v1.5/pro/text-to-video": 10.0,
  "fal-ai/minimax/video-01-live": 8.0,
};

const TASK_TYPE_MODEL_MAP = {
  parsing: "gpt-4o-mini",
  lightweight: "gpt-4o-mini",
  generation: "gpt-4o-mini",
  campaign_generation: "gpt-4o",
  high_quality: "gpt-4o",
};

/**
 * Select the model ID for a given task type.
 * @param {string} taskType — one of: parsing, lightweight, generation, campaign_generation, high_quality
 * @returns {string} model ID
 */
export function selectModel(taskType) {
  return TASK_TYPE_MODEL_MAP[taskType] ?? "gpt-4o-mini";
}

/**
 * Get cost metadata for a model.
 * @param {string} modelId
 * @returns {{ inputCostPer1M: number, outputCostPer1M: number }}
 */
export function getModelCost(modelId) {
  return MODEL_COSTS[modelId] ?? MODEL_COSTS["gpt-4o-mini"];
}

/**
 * Check if a model ID is a Fal.ai model.
 */
export function isFalModel(modelId) {
  return typeof modelId === "string" && modelId.startsWith("fal-ai/");
}

/**
 * Check if a model ID is an OpenAI model.
 */
export function isOpenAIModel(modelId) {
  return typeof modelId === "string" && modelId.startsWith("gpt-");
}

/**
 * Get fixed per-call cost in cents for a Fal model.
 * Returns 0 for unknown Fal models.
 */
export function estimateFalCostCents(modelId) {
  return FAL_MODEL_COSTS[modelId] ?? 0;
}

/**
 * Estimate cost in cents for a given model + token counts.
 * Fal models use fixed per-call pricing; OpenAI models use token math.
 * @param {string} modelId
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number} estimated cost in cents
 */
export function estimateCostCents(modelId, promptTokens, completionTokens) {
  if (isFalModel(modelId)) {
    return estimateFalCostCents(modelId);
  }
  const costs = getModelCost(modelId);
  const inputCost = (promptTokens / 1_000_000) * costs.inputCostPer1M;
  const outputCost = (completionTokens / 1_000_000) * costs.outputCostPer1M;
  // Convert dollars to cents
  return Math.round((inputCost + outputCost) * 100 * 1000) / 1000;
}
