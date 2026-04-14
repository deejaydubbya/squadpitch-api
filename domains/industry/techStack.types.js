// Tech stack types — shared capability and category definitions.
//
// These types define the structure for future industry-specific
// tool integrations (MLS, CRM, publishing platforms, etc.).
// No providers are implemented yet — this is foundational config only.

/**
 * What kind of external system a tool is.
 * @typedef {"data_source" | "crm" | "publishing" | "analytics" | "website" | "operations" | "documents" | "compliance"} TechStackCategory
 */

/**
 * What Squadpitch can DO with a connected tool.
 * @typedef {"imports" | "content_source" | "publishing" | "analytics_source" | "lead_sync" | "client_sync" | "document_source" | "data_enrichment" | "workflow_trigger" | "scheduling_target" | "reporting_source" | "compliance_context"} IntegrationCapability
 */

/**
 * How a tool will eventually be activated from a UX perspective.
 * @typedef {"oauth" | "manual" | "planned"} ConnectionMode
 */

/**
 * A recommended tool within an industry's tech stack.
 * @typedef {Object} IndustryTechStackItem
 * @property {string} providerKey - Unique identifier for the provider
 * @property {string} label - Display name
 * @property {TechStackCategory} category - What kind of system this is
 * @property {"core" | "recommended" | "optional"} priority - How important this tool is for the industry
 * @property {"live" | "beta" | "planned"} status - Current implementation status
 * @property {ConnectionMode} [connectionMode] - How the user will connect this tool (oauth, manual, or planned)
 * @property {string} [description] - What this tool does
 * @property {string[]} [useCases] - Example use cases within Squadpitch
 * @property {IntegrationCapability[]} capabilities - What Squadpitch can do with this tool
 */

/** @type {TechStackCategory[]} */
export const TECH_STACK_CATEGORIES = [
  "data_source",
  "crm",
  "publishing",
  "analytics",
  "website",
  "operations",
  "documents",
  "compliance",
];

/** @type {IntegrationCapability[]} */
export const INTEGRATION_CAPABILITIES = [
  "imports",
  "content_source",
  "publishing",
  "analytics_source",
  "lead_sync",
  "client_sync",
  "document_source",
  "data_enrichment",
  "workflow_trigger",
  "scheduling_target",
  "reporting_source",
  "compliance_context",
];
