// Auto-upsert User on every authenticated request.
// Replaces the old requireAdmin middleware — any authenticated user is allowed.
//
// Fly.io can sleep BOTH the API machine AND the Postgres machine.  When a
// request wakes the API, the DB may still be booting (3-8 s).  We give it
// enough time and reconnect aggressively so users never see "Failed to
// resolve user" in normal cold-start scenarios.

import { getAuth0Sub } from "./auth.js";
import { sendError } from "../lib/apiErrors.js";
import { prisma, reconnectPrisma, isConnected } from "../prisma.js";
import { env } from "../config/env.js";

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 1000, 2000, 3000, 4000]; // total wait budget: 10s

async function hasVerifiedAuth0Email(req, expectedEmail) {
  const payload = req.auth?.payload;
  if (
    payload?.email_verified === true ||
    payload?.["https://squadpitch.com/email_verified"] === true
  ) {
    return true;
  }

  // Auth0 custom-API access tokens do not necessarily contain the standard
  // email_verified claim. On the rare email-collision path, confirm it with
  // Auth0 directly using the already-validated bearer token.
  const token = req.auth?.token;
  if (!token) return false;

  try {
    const response = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const profile = await response.json();
    return (
      profile?.email_verified === true &&
      typeof profile.email === "string" &&
      profile.email.toLowerCase() === expectedEmail.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function requireUser(req, res, next) {
  const sub = getAuth0Sub(req);
  if (!sub) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing token");
  }

  const email =
    req.auth?.payload?.email ||
    req.auth?.payload?.["https://squadpitch.com/email"] ||
    `${sub}@unknown`;
  const name =
    req.auth?.payload?.name ||
    req.auth?.payload?.["https://squadpitch.com/name"] ||
    null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (BACKOFF_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }

      // On retries, verify the pool is alive before running the upsert
      if (attempt > 0) {
        const alive = await isConnected();
        if (!alive) {
          console.warn(
            `[requireUser] Pool dead on attempt ${attempt + 1}, reconnecting...`,
          );
          await reconnectPrisma();
        }
      }

      let user;
      try {
        user = await prisma.user.upsert({
          where: { auth0Sub: sub },
          update: {},
          create: {
            auth0Sub: sub,
            email,
            name,
          },
        });
      } catch (err) {
        const targets = Array.isArray(err.meta?.target)
          ? err.meta.target
          : [err.meta?.target];
        const emailCollision =
          err.code === "P2002" &&
          targets.some((target) => String(target).includes("email"));

        if (!emailCollision) throw err;
        if (!(await hasVerifiedAuth0Email(req, email))) {
          req.log?.warn(
            { event: "auth.account_link_rejected", reason: "email_unverified" },
            "existing account requires a verified email",
          );
          return sendError(
            res,
            409,
            "ACCOUNT_LINK_REQUIRED",
            "This email is already associated with an account. Verify your email and log in again.",
          );
        }

        // Auth0 can issue a different subject when an existing person uses a
        // different connection/provider. Workspace ownership historically
        // used that subject directly, so migrate it in the same transaction
        // that rebinds the stable User record.
        const linked = await prisma.$transaction(async (tx) => {
          const existing = await tx.user.findUniqueOrThrow({
            where: { email },
            select: { auth0Sub: true },
          });
          const ownership = await tx.client.updateMany({
            where: { createdBy: existing.auth0Sub },
            data: { createdBy: sub },
          });
          const linkedUser = await tx.user.update({
            where: { email },
            data: { auth0Sub: sub },
          });
          return { linkedUser, migratedWorkspaceRecords: ownership.count };
        });
        user = linked.linkedUser;
        req.log?.info(
          {
            event: "auth.account_linked_by_verified_email",
            userId: user.id,
            migratedWorkspaceRecords: linked.migratedWorkspaceRecords,
          },
          "reconciled existing Auth0 identity",
        );
      }

      req.user = user;
      req.auth0Sub = sub;
      return next();
    } catch (err) {
      if (attempt < MAX_ATTEMPTS - 1) {
        console.warn(
          `[requireUser] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${err.message}`,
        );
        // Eagerly reconnect — the pool likely has dead connections
        try {
          await reconnectPrisma();
        } catch (reconnectErr) {
          console.warn("[requireUser] Reconnect failed:", reconnectErr.message);
        }
        continue;
      }
      console.error(
        `[requireUser] All ${MAX_ATTEMPTS} attempts failed: ${err.message}`,
      );
      return sendError(res, 500, "INTERNAL", "Failed to resolve user");
    }
  }
}
