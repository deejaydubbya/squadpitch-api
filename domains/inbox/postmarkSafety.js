const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const STREAM_RE = /^[a-z][a-z0-9_-]{0,29}$/;

function senderAddress(value) {
  const normalized = String(value || "").trim();
  const displayNameMatch = normalized.match(/<([^<>]+)>$/);
  return displayNameMatch ? displayNameMatch[1].trim() : normalized;
}

export function validatePostmarkProductionConfig(config) {
  const errors = [];

  if (!EMAIL_RE.test(senderAddress(config.NOTIFICATION_FROM_EMAIL))) {
    errors.push("NOTIFICATION_FROM_EMAIL must be a valid verified sender");
  }
  if (!EMAIL_RE.test(senderAddress(config.INBOX_EMAIL_FROM))) {
    errors.push("INBOX_EMAIL_FROM must be a valid verified sender");
  }
  if (!DOMAIN_RE.test(String(config.INBOX_EMAIL_REPLY_DOMAIN || ""))) {
    errors.push("INBOX_EMAIL_REPLY_DOMAIN must be a valid inbound domain");
  }
  if (!STREAM_RE.test(String(config.POSTMARK_MESSAGE_STREAM || ""))) {
    errors.push("POSTMARK_MESSAGE_STREAM must be a valid message stream ID");
  }
  if (String(config.POSTMARK_INBOUND_WEBHOOK_SECRET || "").length < 32) {
    errors.push(
      "POSTMARK_INBOUND_WEBHOOK_SECRET must contain at least 32 characters",
    );
  }

  return errors;
}

export function requireSuccessfulPostmarkResponse(response) {
  const errorCode = Number(response?.ErrorCode);
  if (!response || !Number.isFinite(errorCode) || errorCode !== 0) {
    const error = new Error(
      typeof response?.Message === "string" && response.Message
        ? response.Message
        : "Postmark did not confirm message acceptance",
    );
    error.code = "POSTMARK_REJECTED";
    error.postmarkErrorCode = Number.isFinite(errorCode) ? errorCode : null;
    throw error;
  }
  if (typeof response.MessageID !== "string" || !response.MessageID.trim()) {
    const error = new Error("Postmark response did not include a message ID");
    error.code = "POSTMARK_INVALID_RESPONSE";
    throw error;
  }
  return response;
}
