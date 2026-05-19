// Shared export error type. Extracted from ads.export.service.js
// during the ads-04 refactor so the exporters/* modules can throw
// the same error shape the routes already translate into HTTP
// responses, without forcing a circular import.

export class ExportError extends Error {
  constructor(message, { status = 400, code = "EXPORT_FAILED" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
