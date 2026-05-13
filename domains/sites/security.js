// Public-surface security helpers — IP hashing, honeypot
// validation, and per-field validation of incoming form data
// against the LeadForm's fieldsJson definition.

import crypto from "node:crypto";

/**
 * SHA-256(ip + salt). We never want to persist raw IPs on
 * FormSubmission rows; the hash gives us repeat-detection +
 * coarse abuse rate-limiting without becoming a PII liability.
 *
 * Returns null when the IP is missing OR the salt isn't set
 * (development env). The route handler treats null as "no IP
 * recorded" rather than blocking — the rate limiter has its
 * own per-IP scope keyed off the raw req.ip elsewhere.
 */
export function hashIp(ip) {
  if (typeof ip !== "string" || ip.length === 0) return null;
  const salt = process.env.RUNTIME_IP_SALT;
  if (!salt) {
    // In dev we still let things through, just without a hash.
    return null;
  }
  return crypto.createHash("sha256").update(`${ip}|${salt}`).digest("hex");
}

/**
 * The standard honeypot pattern: a hidden field that real
 * browsers leave empty and bots fill in. Form rendering wraps
 * this field in a CSS-hidden container; receiving a non-empty
 * value here is grounds to silently reject the submission.
 *
 * Returns `true` when the honeypot tripped (i.e. it's a bot);
 * the caller should respond 200 OK to avoid signaling success
 * vs. silent-drop to the attacker.
 */
export function honeypotTripped(submittedFields) {
  if (!submittedFields || typeof submittedFields !== "object") return false;
  const honey = submittedFields["sp_hp"];
  return typeof honey === "string" && honey.length > 0;
}

/**
 * Validate the submitted fields against the LeadForm's
 * fieldsJson definition. Returns { ok: true, fields }
 * (sanitized) or { ok: false, errors: [...] }.
 *
 * Validation rules per field def:
 *   - key (string) must exist in submitted payload OR field's
 *     `required` flag must be false
 *   - type='text' or anything default: trim, max 2000 chars
 *   - type='email': trim, max 320 chars, must contain '@'
 *   - type='phone': trim, max 32 chars, digits/+/-/space/parens
 *   - type='textarea': trim, max 10_000 chars
 *   - type='select': value must be one of `options[]`
 *   - type='checkbox': coerced to boolean
 *
 * Unknown field keys in the submission are silently dropped —
 * we never persist anything the form doesn't declare.
 */
export function validateFormFields(fieldDefs, submittedFields) {
  if (!Array.isArray(fieldDefs) || fieldDefs.length === 0) {
    return { ok: false, errors: ["Form has no fields defined"] };
  }
  if (!submittedFields || typeof submittedFields !== "object") {
    return { ok: false, errors: ["Missing fields object"] };
  }

  const errors = [];
  const sanitized = {};

  for (const def of fieldDefs) {
    if (!def || typeof def !== "object" || typeof def.key !== "string" || !def.key) continue;
    const raw = submittedFields[def.key];
    const required = def.required === true;

    if (raw === undefined || raw === null || raw === "") {
      if (required) errors.push(`Missing required field: ${def.key}`);
      continue;
    }

    switch (def.type) {
      case "email": {
        const v = String(raw).trim();
        if (v.length > 320) {
          errors.push(`Field ${def.key} too long`);
          continue;
        }
        if (!v.includes("@") || v.length < 3) {
          errors.push(`Field ${def.key} is not a valid email`);
          continue;
        }
        sanitized[def.key] = v;
        break;
      }
      case "phone": {
        const v = String(raw).trim();
        if (v.length > 32) {
          errors.push(`Field ${def.key} too long`);
          continue;
        }
        if (!/^[\d+\-() .]+$/.test(v)) {
          errors.push(`Field ${def.key} contains invalid characters`);
          continue;
        }
        sanitized[def.key] = v;
        break;
      }
      case "textarea": {
        const v = String(raw).slice(0, 10_000);
        sanitized[def.key] = v.trim();
        break;
      }
      case "select": {
        const v = String(raw).trim();
        const options = Array.isArray(def.options) ? def.options : [];
        if (options.length > 0 && !options.includes(v)) {
          errors.push(`Field ${def.key} value not in allowed options`);
          continue;
        }
        sanitized[def.key] = v;
        break;
      }
      case "checkbox": {
        sanitized[def.key] = Boolean(raw);
        break;
      }
      case "text":
      default: {
        const v = String(raw).slice(0, 2000).trim();
        sanitized[def.key] = v;
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, fields: sanitized };
}

/**
 * Best-effort client IP extraction. Trusts x-forwarded-for /
 * fly-client-ip headers because Fly's HTTP service inserts
 * them. Falls back to req.ip (Express default) when neither is
 * present.
 */
export function getClientIp(req) {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly.length > 0) return fly;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    // First entry is the original client; subsequent entries are
    // proxies. Trim each defensively.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || null;
}
