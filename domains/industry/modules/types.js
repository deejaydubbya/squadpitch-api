// industry-03 — IndustryModule shape (JSDoc).
//
// Each industry module defines the configurable surface that
// changes per vertical. The registry loads modules by key; core
// services (prompt builder, sites generation, etc.) compose
// neutral defaults + the active module's overrides.
//
// Real estate is one module. The generic module fills in for
// no-industry and not-yet-extracted industries. Future verticals
// add a new directory under modules/<key>/ — no core changes
// required.
//
// @typedef {object} CampaignTypeOption
// @property {string} value     — slug used in DB / prompts
// @property {string} label     — human label for UI chips
// @property {string} description
//
// @typedef {object} SiteTemplate
// @property {string} key       — slug used in DB
// @property {string} label     — human label
// @property {string} intent    — one-line goal
// @property {string[]} blocks  — recommended block sequence
//
// @typedef {object} IndustryModule
// @property {string} key                                     — e.g. 'real_estate' | 'generic'
// @property {string} label                                   — human label
// @property {CampaignTypeOption[]} campaignTypes             — UI chip options
// @property {SiteTemplate[]} siteTemplates                   — page-gen templates
// @property {string[]} autopilotTriggerTypes                 — empty array → feature disabled
// @property {object} promptAddons
// @property {(typeKey: string) => string|null} promptAddons.getCampaignTypeInstructions
// @property {() => string[]} promptAddons.getFactsLlmMayNotFabricate
// @property {(ctx: object) => string|null} [promptAddons.getSystemPromptAddon]
// @property {object} [urlExtraction]                         — set if industry has a URL extractor
// @property {object} [leadFields]                            — extra contact/lead fields
// @property {object[]} [dashboardWidgets]                    — industry-specific dashboard widgets
// @property {object[]} [onboardingQuestions]                 — extra onboarding questions
//
// Modules MUST be pure config + pure functions. No prisma reads,
// no network calls — anything stateful goes in a service that
// reads from the module.
