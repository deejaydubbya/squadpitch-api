import { describe, expect, it } from "vitest";

import {
  MODEL_REGISTRY_ERROR_CODES,
  buildDefaultModelRegistry,
  isSelectedForCanary,
  requireCompatibleModel,
  rollbackTargetFor,
  selectRegistryModel,
  verifyRegistryArtifact,
} from "../domains/aiPlatform/modelRegistry.service.js";

describe("AI model registry", () => {
  it("verifies local development artifact checksums", () => {
    const [entry] = buildDefaultModelRegistry();

    expect(verifyRegistryArtifact(entry)).toBe(true);
    expect(() =>
      verifyRegistryArtifact({
        ...entry,
        artifactChecksumSha256: "0".repeat(64),
      }),
    ).toThrow(
      expect.objectContaining({
        code: MODEL_REGISTRY_ERROR_CODES.CHECKSUM_MISMATCH,
      }),
    );
  });

  it("rejects missing models and incompatible schemas", () => {
    const registry = buildDefaultModelRegistry();

    expect(() =>
      requireCompatibleModel({
        registry,
        modelId: "brand-content-quality",
        version: "missing",
        schemaVersion: "brand-content-quality.v1",
      }),
    ).toThrow(
      expect.objectContaining({
        code: MODEL_REGISTRY_ERROR_CODES.MODEL_NOT_FOUND,
      }),
    );
    expect(() =>
      requireCompatibleModel({
        registry,
        modelId: "brand-content-quality",
        version: "brand-quality-neural-shadow.v1",
        schemaVersion: "future-schema.v1",
      }),
    ).toThrow(
      expect.objectContaining({
        code: MODEL_REGISTRY_ERROR_CODES.SCHEMA_INCOMPATIBLE,
      }),
    );
  });

  it("supports version pinning, canary selection, and rollback lookup", () => {
    const registry = buildDefaultModelRegistry();
    const canary = {
      ...registry[0],
      version: "brand-quality-neural-shadow.v2",
      deploymentStatus: "canary",
      rolloutPercentage: 100,
      rollbackTarget: "brand-content-quality:brand-quality-neural-shadow.v1",
      artifactUri: "s3://models/brand-quality-neural-shadow.v2/model.bin",
    };
    const active = {
      ...registry[0],
      deploymentStatus: "active",
      rolloutPercentage: 100,
    };
    const registryWithRollout = [canary, active, registry[1]];

    expect(
      selectRegistryModel({
        registry: registryWithRollout,
        modelId: "brand-content-quality",
        pinnedVersion: "brand-quality-neural-shadow.v1",
        schemaVersion: "brand-content-quality.v1",
      }).version,
    ).toBe("brand-quality-neural-shadow.v1");
    expect(
      selectRegistryModel({
        registry: registryWithRollout,
        modelId: "brand-content-quality",
        schemaVersion: "brand-content-quality.v1",
        canaryKey: "workspace-a",
        allowCanary: true,
      }).version,
    ).toBe("brand-quality-neural-shadow.v2");
    expect(
      rollbackTargetFor({
        registry: registryWithRollout,
        modelId: "brand-content-quality",
        version: "brand-quality-neural-shadow.v2",
      }).version,
    ).toBe("brand-quality-neural-shadow.v1");
  });

  it("uses deterministic canary bucket selection", () => {
    expect(isSelectedForCanary("workspace-a", 0)).toBe(false);
    expect(isSelectedForCanary("workspace-a", 100)).toBe(true);
    expect(isSelectedForCanary("workspace-a", 25)).toBe(
      isSelectedForCanary("workspace-a", 25),
    );
  });
});
