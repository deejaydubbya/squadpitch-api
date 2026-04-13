// AI Model Router — central config for task-type → model mapping with cost metadata.

const MODEL_COSTS = {
  "gpt-4o-mini": { inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  "gpt-4o": { inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
};

const TASK_TYPE_MODEL_MAP = {
  parsing: "gpt-4o-mini",
  lightweight: "gpt-4o-mini",
  generation: "gpt-4o-mini",
  high_quality: "gpt-4o",
};

/**
 * Select the model ID for a given task type.
 * @param {string} taskType — one of: parsing, lightweight, generation, high_quality
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
 * Estimate cost in cents for a given model + token counts.
 * @param {string} modelId
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number} estimated cost in cents
 */
export function estimateCostCents(modelId, promptTokens, completionTokens) {
  const costs = getModelCost(modelId);
  const inputCost = (promptTokens / 1_000_000) * costs.inputCostPer1M;
  const outputCost = (completionTokens / 1_000_000) * costs.outputCostPer1M;
  // Convert dollars to cents
  return Math.round((inputCost + outputCost) * 100 * 1000) / 1000;
}
