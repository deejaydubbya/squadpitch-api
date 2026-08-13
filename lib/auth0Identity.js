import { env } from "../config/env.js";

export function normalizeIdentityEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

export async function resolveAuthoritativeIdentity(req, fetchImpl = fetch) {
  const token = req.auth?.token;
  if (!token) return { authenticated: false, email: null, emailVerified: false, sub: null };
  try {
    const response = await fetchImpl(`https://${env.AUTH0_DOMAIN}/userinfo`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { authenticated: true, email: null, emailVerified: false, sub: req.auth?.payload?.sub || null };
    const profile = await response.json();
    return {
      authenticated: true,
      email: normalizeIdentityEmail(profile?.email),
      emailVerified: profile?.email_verified === true,
      sub: typeof profile?.sub === "string" ? profile.sub : req.auth?.payload?.sub || null,
    };
  } catch {
    return { authenticated: true, email: null, emailVerified: false, sub: req.auth?.payload?.sub || null };
  }
}

export async function requireAuthoritativeVerifiedEmail(req) {
  const identity = await resolveAuthoritativeIdentity(req);
  if (!identity.emailVerified || !identity.email) {
    throw Object.assign(new Error("Verify your email before creating or claiming a Squadpitch workspace."), { status: 403, code: "VERIFIED_EMAIL_REQUIRED" });
  }
  return identity.email;
}

export async function resendAuth0Verification(req, fetchImpl = fetch) {
  const identity = await resolveAuthoritativeIdentity(req, fetchImpl);
  if (identity.emailVerified) return { sent: false, alreadyVerified: true };
  const domain = process.env.AUTH0_MANAGEMENT_DOMAIN || env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_MANAGEMENT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
  if (!clientId || !clientSecret || !identity.sub) {
    throw Object.assign(new Error("Verification email resend is not configured. Use the resend option on the Auth0 sign-in screen."), { status: 503, code: "VERIFICATION_RESEND_UNAVAILABLE" });
  }
  const tokenResponse = await fetchImpl(`https://${domain}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, audience: `https://${domain}/api/v2/` }) });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) throw Object.assign(new Error("Verification email could not be resent right now."), { status: 503, code: "VERIFICATION_RESEND_FAILED" });
  const job = await fetchImpl(`https://${domain}/api/v2/jobs/verification-email`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_id: identity.sub }) });
  if (!job.ok) throw Object.assign(new Error("Verification email could not be resent right now."), { status: 503, code: "VERIFICATION_RESEND_FAILED" });
  return { sent: true, alreadyVerified: false };
}
