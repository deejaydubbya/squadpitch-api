// Auto-upsert User on every authenticated request.
// Replaces the old requireAdmin middleware — any authenticated user is allowed.

import { getAuth0Sub } from "./auth.js";
import { sendError } from "../lib/apiErrors.js";
import { prisma } from "../prisma.js";

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

  // Retry once on transient DB connection errors
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
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
      if (attempt === 0) {
        console.warn("[requireUser] Upsert failed, retrying:", err.message);
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      console.error("[requireUser] Failed to upsert user after retry:", err.message);
      return sendError(res, 500, "INTERNAL", "Failed to resolve user");
    }
  }
}
