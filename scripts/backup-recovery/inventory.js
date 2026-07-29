export const backupRecoveryInventory = Object.freeze([
  {
    id: "postgres",
    classification: "IRREPLACEABLE",
    role: "System of record for workspace, content, integrations, billing mirrors, inbox, audit, idempotency, and job state.",
    targetRpo: "15 minutes",
    targetRto: "4 hours",
    requiredEvidence: ["provider-pitr-enabled", "restore-drill-within-90-days"],
  },
  {
    id: "cloudinary",
    classification: "IRREPLACEABLE",
    role: "Original and generated media bytes; Postgres stores URLs and metadata, not the bytes.",
    targetRpo: "24 hours",
    targetRto: "8 hours",
    requiredEvidence: ["asset-backup-or-versioning-confirmed", "sample-asset-restore-tested"],
  },
  {
    id: "redis",
    classification: "MIXED",
    role: "Caches and ephemeral locks plus durable-at-runtime BullMQ jobs, repeat schedules, retries, and delayed work.",
    targetRpo: "1 hour",
    targetRto: "2 hours",
    requiredEvidence: ["persistence-policy-confirmed", "queue-reconciliation-tested"],
  },
  {
    id: "secrets-config",
    classification: "IRREPLACEABLE",
    role: "Fly secrets, provider credentials, webhook signing secrets, encryption keys, and environment configuration.",
    targetRpo: "On every change",
    targetRto: "2 hours",
    requiredEvidence: ["escrow-owner-confirmed", "rotation-and-restore-drill"],
  },
  {
    id: "stripe",
    classification: "EXTERNAL_SYSTEM_OF_RECORD",
    role: "Customers, subscriptions, invoices, payments, and replayable webhook events.",
    targetRpo: "Provider-managed",
    targetRto: "4 hours for reconciliation",
    requiredEvidence: ["live-workbench-access-confirmed", "reconciliation-export-tested"],
  },
  {
    id: "auth0",
    classification: "EXTERNAL_SYSTEM_OF_RECORD",
    role: "Identities, credentials, roles, actions, application configuration, and connections.",
    targetRpo: "24 hours",
    targetRto: "8 hours",
    requiredEvidence: ["tenant-config-export-tested", "user-export-policy-confirmed"],
  },
  {
    id: "ai-retrieval",
    classification: "REBUILDABLE",
    role: "Current retrieval rows and embeddings are process-memory derived data; authoritative sources remain in Postgres.",
    targetRpo: "No independent RPO",
    targetRto: "8 hours after Postgres",
    requiredEvidence: ["reindex-procedure-implemented-before-production-use"],
  },
]);

export function validateBackupRecoveryInventory(
  inventory = backupRecoveryInventory,
) {
  const errors = [];
  const requiredIds = [
    "postgres",
    "cloudinary",
    "redis",
    "secrets-config",
    "stripe",
    "auth0",
    "ai-retrieval",
  ];
  const ids = new Set();

  for (const item of inventory) {
    if (!item?.id || ids.has(item.id)) {
      errors.push(`Inventory id is missing or duplicated: ${item?.id ?? "<missing>"}`);
      continue;
    }
    ids.add(item.id);
    for (const field of ["classification", "role", "targetRpo", "targetRto"]) {
      if (!item[field]) errors.push(`${item.id}.${field} is required`);
    }
    if (!Array.isArray(item.requiredEvidence) || item.requiredEvidence.length === 0) {
      errors.push(`${item.id}.requiredEvidence must not be empty`);
    }
  }

  for (const id of requiredIds) {
    if (!ids.has(id)) errors.push(`Required recovery system missing: ${id}`);
  }
  return errors;
}
