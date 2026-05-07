// Magic-byte MIME detection for uploads.
//
// We do NOT trust the Content-Type header or file extension a client sends —
// either is trivially spoofed. Instead we read the first few bytes of the
// upload buffer and match against an allowlist of formats we actually
// support across our publishing channels.
//
// If the bytes don't match an allowlisted signature we return null, and the
// caller is expected to reject the request with a 415 / clear error. We
// never default-allow.

// Allowlist:
//   image/jpeg  – JPEG (FF D8 FF)
//   image/png   – PNG  (89 50 4E 47 0D 0A 1A 0A)
//   image/webp  – WebP (RIFF....WEBP)
//   image/gif   – GIF87a / GIF89a
//   video/mp4   – MP4 ISO BMFF (any "ftyp" with mp4-family brand at offset 4)
//   video/quicktime – MOV (any "ftyp" with qt brand)
//   video/webm  – Matroska/WebM (1A 45 DF A3)

/** @returns {string|null} */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 && // G
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x38 && // 8
    (buffer[4] === 0x37 /* 7 */ || buffer[4] === 0x39 /* 9 */) &&
    buffer[5] === 0x61 // a
  ) {
    return "image/gif";
  }

  // WebP: "RIFF" + 4 bytes size + "WEBP"
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  ) {
    return "image/webp";
  }

  return null;
}

/** @returns {string|null} */
export function sniffVideoMime(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // WebM / Matroska: 1A 45 DF A3 — only needs 4 bytes
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return "video/webm";
  }

  if (buffer.length < 12) return null;

  // ISO BMFF (mp4, mov): bytes 4-7 = "ftyp", brand at bytes 8-11
  if (
    buffer[4] === 0x66 && // f
    buffer[5] === 0x74 && // t
    buffer[6] === 0x79 && // y
    buffer[7] === 0x70 // p
  ) {
    const brand = buffer.slice(8, 12).toString("ascii");
    // Accept the common MP4 family brands. "qt  " = QuickTime.
    if (
      brand === "isom" ||
      brand === "iso2" ||
      brand === "iso4" ||
      brand === "iso5" ||
      brand === "mp41" ||
      brand === "mp42" ||
      brand === "avc1" ||
      brand === "M4V " ||
      brand === "M4A " ||
      brand === "f4v "
    ) {
      return "video/mp4";
    }
    if (brand === "qt  ") return "video/quicktime";
  }

  return null;
}

/**
 * Sniff and validate against an explicit allowlist.
 * Returns the detected MIME, or throws a 415-style error.
 *
 * @param {Buffer} buffer
 * @param {{ kind: 'image'|'video'|'any' }} [opts]
 */
export function sniffOrReject(buffer, { kind = "any" } = {}) {
  let detected = null;
  if (kind === "image" || kind === "any") {
    detected = sniffImageMime(buffer);
  }
  if (!detected && (kind === "video" || kind === "any")) {
    detected = sniffVideoMime(buffer);
  }
  if (!detected) {
    const err = new Error(
      kind === "image"
        ? "Unsupported image format. Allowed: JPEG, PNG, WebP, GIF."
        : kind === "video"
        ? "Unsupported video format. Allowed: MP4, MOV, WebM."
        : "Unsupported file type. Allowed: JPEG, PNG, WebP, GIF, MP4, MOV, WebM."
    );
    err.status = 415;
    err.code = "UNSUPPORTED_MEDIA_TYPE";
    throw err;
  }
  return detected;
}

/** Test-only convenience for assembling tiny fixture buffers. */
export const SIGNATURES = Object.freeze({
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif87: Buffer.from("GIF87a"),
  gif89: Buffer.from("GIF89a"),
  webp: Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP"),
  ]),
  mp4: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftyp"),
    Buffer.from("mp42"),
  ]),
  mov: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftyp"),
    Buffer.from("qt  "),
  ]),
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
});
