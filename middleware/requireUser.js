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

  try {
    const email =
      req.auth?.payload?.email ||
      req.auth?.payload?.["https://squadpitch.com/email"] ||
      `${sub}@unknown`;
    const name =
      req.auth?.payload?.name ||
      req.auth?.payload?.["https://squadpitch.com/name"] ||
      null;

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
    console.error("[requireUser] Failed to upsert user:", err.message);
    return sendError(res, 500, "INTERNAL", "Failed to resolve user");
  }
}
