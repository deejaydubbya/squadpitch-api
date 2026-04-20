// Declarative workflow step definitions for the AI Content Assistant.

/**
 * @typedef {Object} WorkflowStep
 * @property {string} id
 * @property {string} label
 * @property {string[]} modes - Which assistant modes include this step
 * @property {string[]} required - Session fields that must be non-null/non-empty to proceed
 * @property {boolean} [skippable] - Whether the step can be skipped
 */

/** @type {WorkflowStep[]} */
export const WORKFLOW_STEPS = [
  {
    id: "mode_select",
    label: "Choose Mode",
    modes: ["campaign", "quick_post"],
    required: ["mode"],
  },
  {
    id: "property_select",
    label: "Select Property",
    modes: ["campaign", "quick_post"],
    required: ["selectedPropertyId"],
    skippable: (session) => session.mode === "quick_post",
  },
  {
    id: "campaign_config",
    label: "Campaign Settings",
    modes: ["campaign"],
    required: ["campaignType", "channels"],
  },
  {
    id: "media_select",
    label: "Select Media",
    modes: ["campaign", "quick_post"],
    required: [],
    skippable: () => true,
  },
  {
    id: "schedule_review",
    label: "Review Schedule",
    modes: ["campaign"],
    required: ["slots"],
  },
  {
    id: "generate",
    label: "Generate",
    modes: ["campaign", "quick_post"],
    required: [],
  },
];

/**
 * Get steps applicable to a given mode.
 * @param {'campaign' | 'quick_post'} mode
 * @returns {WorkflowStep[]}
 */
export function getStepsForMode(mode) {
  return WORKFLOW_STEPS.filter((step) => step.modes.includes(mode));
}

/**
 * Validate whether a step's requirements are met by the current session.
 * @param {string} stepId
 * @param {object} session
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateStep(stepId, session) {
  const step = WORKFLOW_STEPS.find((s) => s.id === stepId);
  if (!step) return { valid: false, missing: [`unknown step: ${stepId}`] };

  const missing = step.required.filter((field) => {
    const value = session[field];
    if (value === null || value === undefined) return true;
    if (Array.isArray(value) && value.length === 0) return true;
    return false;
  });

  return { valid: missing.length === 0, missing };
}

/**
 * Default channels recommended per campaign type.
 * @type {Record<string, string[]>}
 */
export const DEFAULT_CHANNELS_BY_CAMPAIGN_TYPE = {
  just_listed: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
  open_house: ["INSTAGRAM", "FACEBOOK"],
  price_drop: ["INSTAGRAM", "FACEBOOK"],
  general_promotion: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
};
