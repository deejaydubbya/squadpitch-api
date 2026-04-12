// Document parser for onboarding file uploads.
//
// Extracts text from PDF, DOCX, TXT, and CSV files.

import { createRequire } from "module";
import mammoth from "mammoth";

// pdf-parse v1 is CJS and tries to load a test file on import.
// Using createRequire + direct lib path avoids both issues.
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse/lib/pdf-parse.js");

const SUPPORTED_TYPES = new Map([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
]);

const SUPPORTED_EXTENSIONS = new Map([
  [".pdf", "pdf"],
  [".docx", "docx"],
  [".txt", "txt"],
  [".csv", "csv"],
]);

/**
 * Parse a document buffer into text.
 *
 * @param {Buffer} buffer
 * @param {{ filename: string, mimetype: string }} meta
 * @returns {Promise<{ text: string, filename: string }>}
 */
export async function parseDocument(buffer, { filename, mimetype }) {
  // Determine type from mimetype or extension
  let type = SUPPORTED_TYPES.get(mimetype);
  if (!type) {
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    type = SUPPORTED_EXTENSIONS.get(ext);
  }

  if (!type) {
    const err = new Error(`Unsupported file type: ${mimetype || filename}`);
    err.status = 400;
    throw err;
  }

  let text;

  switch (type) {
    case "pdf": {
      const result = await pdf(buffer);
      text = result.text;
      break;
    }
    case "docx": {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      break;
    }
    case "txt":
    case "csv":
      text = buffer.toString("utf-8");
      break;
  }

  return { text: text || "", filename };
}

/**
 * Check if a file is an accepted type for upload.
 */
export function isAcceptedFile(mimetype, filename) {
  if (SUPPORTED_TYPES.has(mimetype)) return true;
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}
