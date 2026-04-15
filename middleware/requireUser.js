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

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (BACKOFF_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }

      // On retries, verify the pool is alive before running the upsert
      if (attempt > 0) {
        const alive = await isConnected();
        if (!alive) {
          console.warn(`[requireUser] Pool dead on attempt ${attempt + 1}, reconnecting...`);
          await reconnectPrisma();
        }
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
        // Eagerly reconnect — the pool likely has dead connections
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
