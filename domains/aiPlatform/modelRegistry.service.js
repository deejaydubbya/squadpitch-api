import crypto from "node:crypto";

export const MODEL_REGISTRY_SCHEMA_VERSION = "model-registry.v1";

export const MODEL_REGISTRY_ERROR_CODES = Object.freeze({
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  VERSION_MISMATCH: "MODEL_VERSION_MISMATCH",
  SCHEMA_INCOMPATIBLE: "MODEL_SCHEMA_INCOMPATIBLE",
  CHECKSUM_MISMATCH: "ARTIFACT_CHECKSUM_MISMATCH",
  ROLLBACK_TARGET_MISSING: "ROLLBACK_TARGET_MISSING",
});

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function localDevChecksum(modelId, version, task) {
  return checksum(`${modelId}:${version}:${task}:local-dev-artifact`);
}

export function buildDefaultModelRegistry({ codeCommit = "local-dev" } = {}) {
  const createdAt = "2026-07-22T00:00:00.000Z";
  return [
    {
      registrySchemaVersion: MODEL_REGISTRY_SCHEMA_VERSION,
      modelId: "brand-content-quality",
      version: "brand-quality-neural-shadow.v1",
      task: "brand_content_quality_classification",
      framework: "fastapi+pytorch-compatible-deterministic-shadow",
      artifactUri:
        "local-dev://brand-content-quality/brand-quality-neural-shadow.v1",
      artifactChecksumSha256: localDevChecksum(
        "brand-content-quality",
        "brand-quality-neural-shadow.v1",
        "brand_content_quality_classification",
      ),
      datasetVersion: "brand-quality-dataset-seed-v1",
      codeCommit,
      trainingParameters: { device: "cpu", batchSize: 1, precision: "float32" },
      metrics: { macroF1: 0, microF1: 0, p95LatencyMs: 0, coldStartMs: 0 },
      calibration: { expectedCalibrationError: 0, trainedArtifactAvailable: 0 },
      compatibilitySchema: "brand-content-quality.v1",
      deploymentStatus: "shadow",
      rolloutPercentage: 0,
      createdAt,
      approvedAt: createdAt,
      retiredAt: null,
      modelCardUri: "docs/ai-platform/BRAND_CONTENT_QUALITY_MODEL_CARD.md",
      rollbackTarget:
        "brand-content-quality:brand-quality-deterministic-shadow.v0",
    },
    {
      registrySchemaVersion: MODEL_REGISTRY_SCHEMA_VERSION,
      modelId: "brand-content-quality",
      version: "brand-quality-deterministic-shadow.v0",
      task: "brand_content_quality_classification",
      framework: "fastapi+deterministic",
      artifactUri:
        "local-dev://brand-content-quality/brand-quality-deterministic-shadow.v0",
      artifactChecksumSha256: localDevChecksum(
        "brand-content-quality",
        "brand-quality-deterministic-shadow.v0",
        "brand_content_quality_classification",
      ),
      datasetVersion: "brand-quality-dataset-seed-v1",
      codeCommit,
      trainingParameters: { device: "cpu", batchSize: 1, precision: "float32" },
      metrics: { macroF1: 0, microF1: 0 },
      calibration: { expectedCalibrationError: 0, trainedArtifactAvailable: 0 },
      compatibilitySchema: "brand-content-quality.v1",
      deploymentStatus: "retired",
      rolloutPercentage: 0,
      createdAt,
      approvedAt: createdAt,
      retiredAt: createdAt,
      modelCardUri: "docs/ai-platform/BRAND_CONTENT_QUALITY_MODEL_CARD.md",
      rollbackTarget: null,
    },
  ];
}

function typedError(code, message, status = 422, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, details);
  return err;
}

export function getRegistryEntry(registry, modelId, version) {
  const entry = registry.find(
    (candidate) =>
      candidate.modelId === modelId && candidate.version === version,
  );
  if (!entry) {
    throw typedError(
      MODEL_REGISTRY_ERROR_CODES.MODEL_NOT_FOUND,
      `Model not found: ${modelId}:${version}`,
      404,
    );
  }
  return entry;
}

export function verifyRegistryArtifact(entry) {
  if (!entry.artifactUri.startsWith("local-dev://")) return true;
  const expected = localDevChecksum(entry.modelId, entry.version, entry.task);
  if (expected !== entry.artifactChecksumSha256) {
    throw typedError(
      MODEL_REGISTRY_ERROR_CODES.CHECKSUM_MISMATCH,
      `Checksum mismatch for ${entry.modelId}:${entry.version}`,
      503,
    );
  }
  return true;
}

export function requireCompatibleModel({
  registry = buildDefaultModelRegistry(),
  modelId,
  version,
  schemaVersion,
}) {
  const entry = getRegistryEntry(registry, modelId, version);
  if (entry.compatibilitySchema !== schemaVersion) {
    throw typedError(
      MODEL_REGISTRY_ERROR_CODES.SCHEMA_INCOMPATIBLE,
      `Model ${modelId}:${version} is not compatible with ${schemaVersion}`,
      422,
    );
  }
  verifyRegistryArtifact(entry);
  return entry;
}

export function selectRegistryModel({
  registry = buildDefaultModelRegistry(),
  modelId,
  pinnedVersion,
  schemaVersion,
  canaryKey = "",
  allowCanary = false,
}) {
  if (pinnedVersion) {
    return requireCompatibleModel({
      registry,
      modelId,
      version: pinnedVersion,
      schemaVersion,
    });
  }
  const active = registry.find(
    (entry) =>
      entry.modelId === modelId &&
      entry.compatibilitySchema === schemaVersion &&
      entry.deploymentStatus === "active",
  );
  const canary = registry.find(
    (entry) =>
      entry.modelId === modelId &&
      entry.compatibilitySchema === schemaVersion &&
      entry.deploymentStatus === "canary",
  );
  if (
    allowCanary &&
    canary &&
    isSelectedForCanary(canaryKey, canary.rolloutPercentage)
  ) {
    return requireCompatibleModel({
      registry,
      modelId,
      version: canary.version,
      schemaVersion,
    });
  }
  if (active) {
    return requireCompatibleModel({
      registry,
      modelId,
      version: active.version,
      schemaVersion,
    });
  }
  const shadow = registry.find(
    (entry) =>
      entry.modelId === modelId &&
      entry.compatibilitySchema === schemaVersion &&
      entry.deploymentStatus === "shadow",
  );
  if (!shadow) {
    throw typedError(
      MODEL_REGISTRY_ERROR_CODES.MODEL_NOT_FOUND,
      `No deployable model for ${modelId}`,
      404,
    );
  }
  return requireCompatibleModel({
    registry,
    modelId,
    version: shadow.version,
    schemaVersion,
  });
}

export function rollbackTargetFor({
  registry = buildDefaultModelRegistry(),
  modelId,
  version,
}) {
  const entry = getRegistryEntry(registry, modelId, version);
  if (!entry.rollbackTarget) {
    throw typedError(
      MODEL_REGISTRY_ERROR_CODES.ROLLBACK_TARGET_MISSING,
      `Model ${modelId}:${version} has no rollback target`,
      422,
    );
  }
  const [, rollbackVersion] = entry.rollbackTarget.split(":");
  return getRegistryEntry(registry, modelId, rollbackVersion);
}

export function isSelectedForCanary(canaryKey, rolloutPercentage) {
  if (rolloutPercentage <= 0) return false;
  if (rolloutPercentage >= 100) return true;
  const bucket =
    Number.parseInt(checksum(String(canaryKey)).slice(0, 8), 16) % 100;
  return bucket < rolloutPercentage;
}
