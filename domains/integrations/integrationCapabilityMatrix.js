export const CAPABILITY_STATUSES = [
  "AVAILABLE",
  "BETA",
  "COMING_SOON",
  "UNAVAILABLE",
];

export const integrationCapabilityMatrix = {
  FACEBOOK: entry("Facebook Pages", "BETA", {
    commentsInbox: "BETA",
    analytics: "BETA",
    approval: "META_APP_REVIEW_REQUIRED",
  }),
  INSTAGRAM: entry("Instagram Business", "BETA", {
    commentsInbox: "BETA",
    analytics: "BETA",
    approval: "META_APP_REVIEW_REQUIRED",
  }),
  LINKEDIN: entry("LinkedIn Personal Profile", "AVAILABLE", {
    mediaPublish: "BETA",
    commentsInbox: "UNAVAILABLE",
    analytics: "UNAVAILABLE",
    approval: "DOCUMENTED_AVAILABLE_PRODUCTS_ONLY",
  }),
  LINKEDIN_ORGANIZATION_PAGE: entry("LinkedIn Organization Page", "BETA", {
    commentsInbox: "COMING_SOON",
    analytics: "COMING_SOON",
    approval: "COMMUNITY_MANAGEMENT_REVIEW_REQUIRED",
  }),
  THREADS: entry("Threads", "AVAILABLE", {
    commentsInbox: "AVAILABLE",
    analytics: "AVAILABLE",
    approval: "DOCUMENTED_APPROVED",
  }),
  YOUTUBE: entry("YouTube", "BETA", {
    commentsInbox: "BETA",
    analytics: "BETA",
    approval: "GOOGLE_SENSITIVE_SCOPE_VERIFICATION_REQUIRED",
  }),
  GOOGLE_BUSINESS_PROFILE: entry("Google Business Profile", "BETA", {
    publish: "UNAVAILABLE",
    mediaPublish: "UNAVAILABLE",
    commentsInbox: "BETA",
    analytics: "UNAVAILABLE",
    approval: "GOOGLE_BUSINESS_PROFILE_API_ACCESS_REQUIRED",
  }),
  TIKTOK: entry("TikTok", "BETA", {
    commentsInbox: "UNAVAILABLE",
    analytics: "UNAVAILABLE",
    approval: "TIKTOK_APP_REVIEW_REQUIRED",
  }),
  PINTEREST: entry("Pinterest", "AVAILABLE", {
    mediaPublish: "BETA",
    commentsInbox: "UNAVAILABLE",
    analytics: "UNAVAILABLE",
    approval: "DOCUMENTED_STANDARD_ACCESS",
  }),
  X: entry("X", "BETA", {
    commentsInbox: "UNAVAILABLE",
    analytics: "UNAVAILABLE",
    approval: "PAID_API_TIER_MAY_BE_REQUIRED",
  }),
  REDDIT: entry("Reddit", "COMING_SOON", {
    webhook: "UNAVAILABLE",
    approval: "NOT_STARTED",
  }),
};

function entry(label, overall, overrides = {}) {
  const defaultCapability = overall === "COMING_SOON" ? "COMING_SOON" : overall;
  return {
    label,
    overall,
    connect: defaultCapability,
    refreshReconnect: defaultCapability,
    publish: defaultCapability,
    mediaPublish: defaultCapability,
    commentsInbox: "UNAVAILABLE",
    analytics: "UNAVAILABLE",
    webhook: "UNAVAILABLE",
    approval: "UNVERIFIED",
    ui: overall,
    ...overrides,
  };
}

export function validateIntegrationCapabilityMatrix(matrix) {
  const errors = [];
  const capabilityKeys = [
    "overall",
    "connect",
    "refreshReconnect",
    "publish",
    "mediaPublish",
    "commentsInbox",
    "analytics",
    "webhook",
    "ui",
  ];
  for (const [provider, descriptor] of Object.entries(matrix)) {
    for (const key of capabilityKeys) {
      if (!CAPABILITY_STATUSES.includes(descriptor[key])) {
        errors.push(`${provider}.${key} has an invalid status`);
      }
    }
    if (
      descriptor.connect === "AVAILABLE" &&
      !descriptor.approval.startsWith("DOCUMENTED_")
    ) {
      errors.push(
        `${provider}.connect cannot be AVAILABLE without documented approval`,
      );
    }
  }
  return errors;
}

export function publicIntegrationCapabilities() {
  return Object.entries(integrationCapabilityMatrix).map(
    ([provider, descriptor]) => ({ provider, ...descriptor }),
  );
}
