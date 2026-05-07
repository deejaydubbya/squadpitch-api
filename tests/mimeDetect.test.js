// Magic-byte MIME detection tests.
//
// We refuse to trust client-supplied Content-Type headers — these are
// what we sniff from the actual buffer.

import { describe, it, expect } from "vitest";
import {
  sniffImageMime,
  sniffVideoMime,
  sniffOrReject,
  SIGNATURES,
} from "../lib/mimeDetect.js";

describe("sniffImageMime", () => {
  it("identifies JPEG", () => {
    expect(sniffImageMime(SIGNATURES.jpeg)).toBe("image/jpeg");
  });

  it("identifies PNG", () => {
    expect(sniffImageMime(SIGNATURES.png)).toBe("image/png");
  });

  it("identifies GIF87a and GIF89a", () => {
    expect(sniffImageMime(SIGNATURES.gif87)).toBe("image/gif");
    expect(sniffImageMime(SIGNATURES.gif89)).toBe("image/gif");
  });

  it("identifies WebP", () => {
    expect(sniffImageMime(SIGNATURES.webp)).toBe("image/webp");
  });

  it("returns null for unsupported types", () => {
    // BMP magic — intentionally not in the allowlist
    expect(sniffImageMime(Buffer.from([0x42, 0x4d]))).toBeNull();
    // Plain text
    expect(sniffImageMime(Buffer.from("hello world"))).toBeNull();
    // Empty / undersized
    expect(sniffImageMime(Buffer.from([0xff]))).toBeNull();
    expect(sniffImageMime(null)).toBeNull();
  });

  it("does not accept HTML disguised as image (XSS bait)", () => {
    expect(sniffImageMime(Buffer.from("<html><body>"))).toBeNull();
  });
});

describe("sniffVideoMime", () => {
  it("identifies MP4 (mp4-family ftyp brand)", () => {
    expect(sniffVideoMime(SIGNATURES.mp4)).toBe("video/mp4");
  });

  it("identifies QuickTime", () => {
    expect(sniffVideoMime(SIGNATURES.mov)).toBe("video/quicktime");
  });

  it("identifies WebM", () => {
    expect(sniffVideoMime(SIGNATURES.webm)).toBe("video/webm");
  });

  it("returns null for an ftyp brand we don't accept", () => {
    const heif = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("ftyp"),
      Buffer.from("heic"),
    ]);
    expect(sniffVideoMime(heif)).toBeNull();
  });

  it("returns null for a JPEG buffer", () => {
    expect(sniffVideoMime(SIGNATURES.jpeg)).toBeNull();
  });
});

describe("sniffOrReject", () => {
  it("returns the detected mime on success", () => {
    expect(sniffOrReject(SIGNATURES.png, { kind: "image" })).toBe("image/png");
    expect(sniffOrReject(SIGNATURES.mp4, { kind: "video" })).toBe("video/mp4");
  });

  it("throws a 415 on a disallowed type", () => {
    expect(() =>
      sniffOrReject(Buffer.from("totally not an image"), { kind: "image" })
    ).toThrowError(
      expect.objectContaining({ status: 415, code: "UNSUPPORTED_MEDIA_TYPE" })
    );
  });

  it("rejects a video buffer when kind is 'image'", () => {
    expect(() => sniffOrReject(SIGNATURES.mp4, { kind: "image" })).toThrowError(
      expect.objectContaining({ status: 415 })
    );
  });
});
