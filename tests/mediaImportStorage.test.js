// Storage-limit + MIME enforcement at the import boundary.
//
// We're mocking everything around `importFile` to prove two contracts:
//   1. If `checkStorageLimit` denies, the function throws 402 and NEVER
//      calls `prisma.mediaAsset.create`.
//   2. If the downloaded buffer doesn't sniff as a supported image/video,
//      the function throws 415 and NEVER calls `prisma.mediaAsset.create`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SIGNATURES } from "../lib/mimeDetect.js";

const prismaMock = {
  integration: {
    findFirst: vi.fn(),
  },
  mediaAsset: {
    create: vi.fn(),
  },
  integrationLog: {
    create: vi.fn().mockResolvedValue({}),
  },
};

const enforceUsageLimitMock = vi.fn().mockResolvedValue(null);
const incrementUsageMock = vi.fn().mockResolvedValue(null);
const checkStorageLimitMock = vi.fn();

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../domains/billing/billing.service.js", () => ({
  enforceUsageLimit: enforceUsageLimitMock,
  incrementUsage: incrementUsageMock,
  checkStorageLimit: checkStorageLimitMock,
}));

// Avoid hitting real Cloudinary — the test paths reject before reaching it,
// but mock to be safe.
vi.mock("../services/storage/imageStorage.js", () => ({
  getImageStorageService: () => ({ upload: vi.fn() }),
  getVideoStorageService: () => ({ upload: vi.fn() }),
}));

const downloadFileMock = vi.fn();
vi.mock("../domains/integrations/providers/driveProvider.js", () => ({
  downloadFile: downloadFileMock,
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock("../domains/integrations/providers/dropboxProvider.js", () => ({
  downloadFile: vi.fn(),
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
}));

const { importFile } = await import(
  "../domains/integrations/mediaImport.service.js"
);

beforeEach(() => {
  prismaMock.integration.findFirst.mockReset();
  prismaMock.mediaAsset.create.mockReset();
  enforceUsageLimitMock.mockReset().mockResolvedValue(null);
  checkStorageLimitMock.mockReset();
  downloadFileMock.mockReset();
});

describe("importFile — storage and MIME enforcement", () => {
  it("blocks the import when storage is over quota and never persists a MediaAsset", async () => {
    prismaMock.integration.findFirst.mockResolvedValue({
      id: "int-1",
      type: "google_drive",
      config: {},
    });
    downloadFileMock.mockResolvedValue({
      buffer: SIGNATURES.png,
      mimeType: "image/png",
      filename: "photo.png",
    });
    checkStorageLimitMock.mockResolvedValue({
      allowed: false,
      reason: "Total storage limit reached.",
      current: 999,
      limit: 1000,
    });

    await expect(
      importFile("user-1", "int-1", "drive-file-1", "client-1")
    ).rejects.toMatchObject({
      status: 402,
      code: "STORAGE_LIMIT",
    });
    expect(prismaMock.mediaAsset.create).not.toHaveBeenCalled();
    expect(incrementUsageMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file type via byte-sniffing, regardless of provider-declared mime", async () => {
    prismaMock.integration.findFirst.mockResolvedValue({
      id: "int-1",
      type: "google_drive",
      config: {},
    });
    // Provider lies and claims this is a PNG; bytes are plain text.
    downloadFileMock.mockResolvedValue({
      buffer: Buffer.from("definitely not an image"),
      mimeType: "image/png",
      filename: "evil.txt",
    });

    await expect(
      importFile("user-1", "int-1", "drive-file-1", "client-1")
    ).rejects.toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    expect(prismaMock.mediaAsset.create).not.toHaveBeenCalled();
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
  });
});
