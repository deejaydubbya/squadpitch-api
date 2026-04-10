import { auth } from "express-oauth2-jwt-bearer";
import { env } from "../config/env.js";
import { sendError } from "../lib/apiErrors.js";

const checkJwt = auth({
  audience: env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${env.AUTH0_DOMAIN}/`,
  tokenSigningAlg: "RS256",
});

export function requireAuth(req, res, next) {
  checkJwt(req, res, (err) => {
    if (err) {
      return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid token");
    }
    return next();
  });
}

export const getAuth0Sub = (req) => req?.auth?.payload?.sub || null;
