const ACCOUNT_SID_RE = /^AC[a-f0-9]{32}$/i;
const MESSAGING_SERVICE_SID_RE = /^MG[a-f0-9]{32}$/i;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

export function validateTwilioProductionConfig(config) {
  const enabled =
    config.SMS_SENDING_ENABLED === true ||
    config.SMS_SENDING_ENABLED === "true";
  const approved =
    config.SMS_A2P_APPROVED === true || config.SMS_A2P_APPROVED === "true";
  const errors = [];

  if (!enabled) return errors;
  if (!approved) {
    errors.push("SMS_SENDING_ENABLED requires SMS_A2P_APPROVED=true");
  }
  if (!ACCOUNT_SID_RE.test(String(config.TWILIO_ACCOUNT_SID || ""))) {
    errors.push("TWILIO_ACCOUNT_SID must be a valid Account SID");
  }
  if (String(config.TWILIO_AUTH_TOKEN || "").length < 16) {
    errors.push("TWILIO_AUTH_TOKEN is required when SMS sending is enabled");
  }
  if (!PHONE_RE.test(String(config.TWILIO_FROM_NUMBER || ""))) {
    errors.push("TWILIO_FROM_NUMBER must be in E.164 format");
  }
  if (
    !MESSAGING_SERVICE_SID_RE.test(
      String(config.TWILIO_MESSAGING_SERVICE_SID || ""),
    )
  ) {
    errors.push("TWILIO_MESSAGING_SERVICE_SID must be a valid Service SID");
  }
  for (const name of [
    "TWILIO_INBOUND_WEBHOOK_URL",
    "TWILIO_STATUS_CALLBACK_URL",
  ]) {
    try {
      const url = new URL(config[name]);
      if (url.protocol !== "https:" || url.username || url.password) {
        errors.push(`${name} must be a credential-free HTTPS URL`);
      }
    } catch {
      errors.push(`${name} must be a valid HTTPS URL`);
    }
  }

  return errors;
}

export function isStopRequest(body = {}) {
  if (
    String(body.OptOutType || "")
      .trim()
      .toUpperCase() === "STOP"
  ) {
    return true;
  }
  return new Set([
    "STOP",
    "STOPALL",
    "UNSUBSCRIBE",
    "CANCEL",
    "END",
    "QUIT",
  ]).has(
    String(body.Body || "")
      .trim()
      .toUpperCase(),
  );
}

export function twilioDeliveryFailure(status) {
  return new Set(["failed", "undelivered", "canceled"]).has(
    String(status || "")
      .trim()
      .toLowerCase(),
  );
}
