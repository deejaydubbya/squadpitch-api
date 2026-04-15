// Auto-upsert User on every authenticated request.
// Replaces the old requireAdmin middleware — any authenticated user is allowed.

import { getAuth0Sub } from "./auth.js";
import { sendError } from "../lib/apiErrors.js";
import { prisma, reconnectPrisma } from "../prisma.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 500, 1500]; // no delay, 500ms, 1500ms

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

  // Retry with backoff — handles Fly.io cold starts where both API and DB may be waking
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (BACKOFF_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }

      const user = await prisma.user.upsert({
        where: { auth0Sub: sub },
        update: {},
        create: {
          auth0Sub: sub,
          email,
          name,
        },
      });

      req.user = user;
      req.auth0Sub = sub;
      return next();
    } catch (err) {
      if (attempt < MAX_ATTEMPTS - 1) {
        console.warn(`[requireUser] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${err.message}`);
        try {
          await reconnectPrisma();
        } catch (reconnectErr) {
          console.warn("[requireUser] Reconnect failed:", reconnectErr.message);
        }
        continue;
      }
      console.error(`[requireUser] All ${MAX_ATTEMPTS} attempts failed: ${err.message}`);
      return sendError(res, 500, "INTERNAL", "Failed to resolve user");
    }
  }
}
