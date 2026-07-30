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

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 1000, 2000, 3000, 4000]; // total wait budget: 10s

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
  const emailVerified =
    req.auth?.payload?.email_verified === true ||
    req.auth?.payload?.["https://squadpitch.com/email_verified"] === true;

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
        if (!emailVerified) {
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
        // different connection/provider. Rebind the existing verified-email
        // record so its user ID and all workspace relationships are preserved.
        user = await prisma.user.update({
          where: { email },
          data: { auth0Sub: sub },
        });
        req.log?.info(
          { event: "auth.account_linked_by_verified_email", userId: user.id },
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
