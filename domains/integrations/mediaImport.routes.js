// Media import routes — OAuth connect/callback for Drive & Dropbox,
// plus file browsing and import endpoints.
//
// Mounted under /api/v1/integrations/media-import

import express from "express";
import crypto from "node:crypto";
import { prisma } from "../../prisma.js";
import { encryptToken } from "../../lib/tokenCrypto.js";
import { redisSet, redisGet, redisDel } from "../../redis.js";
import * as driveProvider from "./providers/driveProvider.js";
import * as dropboxProvider from "./providers/dropboxProvider.js";
import * as sheetsProvider from "./providers/sheetsProvider.js";
import { listFiles, importFile } from "./mediaImport.service.js";

export const mediaImportRouter = express.Router();
const BASE = "/api/v1/integrations/media-import";

const STATE_TTL = 10 * 60; // 10 minutes

// ── OAuth helpers ────────────────────────────────────────────────────

async function createOAuthState(userId, provider) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const key = `sp:media-oauth:${nonce}`;
  await redisSet(key, JSON.stringify({ userId, provider }), STATE_TTL);
  return nonce;
}

async function consumeOAuthState(nonce) {
  const key = `sp:media-oauth:${nonce}`;
  const raw = await redisGet(key);
  if (!raw) return null;
  await redisDel(key);
  return JSON.parse(raw);
}

// ── OAuth: start connect ─────────────────────────────────────────────

/**
 * POST /api/v1/integrations/media-import/connect/:provider
 * Returns { authUrl } for the given provider (google_drive | dropbox).
 */
mediaImportRouter.post(`${BASE}/connect/:provider`, async (req, res, next) => {
  try {
    const { provider } = req.params;
    const state = await createOAuthState(req.user.id, provider);

    let authUrl;
    if (provider === "google_drive") {
      authUrl = driveProvider.getAuthUrl(state);
    } else if (provider === "dropbox") {
      authUrl = dropboxProvider.getAuthUrl(state);
    } else if (provider === "google_sheets") {
      authUrl = sheetsProvider.getAuthUrl(state);
    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    res.json({ authUrl });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/integrations/media-import/callback
 * Body: { code, state }
 * Exchanges the OAuth code, creates/updates the Integration record.
 */
mediaImportRouter.post(`${BASE}/callback`, async (req, res, next) => {
  try {
    const { code, state } = req.body;
    if (!code || !state) {
      return res.status(400).json({ error: "code and state are required" });
    }

    const stateData = await consumeOAuthState(state);
    if (!stateData) {
      return res.status(400).json({ error: "Invalid or expired OAuth state" });
    }

    const { userId, provider } = stateData;

    // Verify the authenticated user matches the state
    if (userId !== req.user.id) {
      return res.status(403).json({ error: "OAuth state user mismatch" });
    }

    let tokens;
    if (provider === "google_drive") {
      tokens = driveProvider.exchangeCode(code);
    } else if (provider === "dropbox") {
      tokens = dropboxProvider.exchangeCode(code);
    } else if (provider === "google_sheets") {
      tokens = sheetsProvider.exchangeCode(code);
    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    tokens = await tokens;

    // Upsert integration — one Drive/Dropbox per user
    const existing = await prisma.integration.findFirst({
      where: { userId, type: provider },
    });

    let integration;
    if (existing) {
      integration = await prisma.integration.update({
        where: { id: existing.id },
        data: {
          config: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            email: tokens.email,
          },
          isActive: true,
        },
      });
    } else {
      const labelMap = { google_drive: "Google Drive", dropbox: "Dropbox", google_sheets: "Google Sheets" };
      const label = labelMap[provider] ?? provider;
      integration = await prisma.integration.create({
        data: {
          userId,
          type: provider,
          name: tokens.email ? `${label} (${tokens.email})` : label,
          config: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            email: tokens.email,
          },
        },
      });
    }

    res.json({
      integration: {
        id: integration.id,
        type: integration.type,
        name: integration.name,
        isActive: integration.isActive,
        email: tokens.email,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── File browsing ────────────────────────────────────────────────────

/**
 * GET /api/v1/integrations/media-import/:integrationId/files
 * Query params: path/folderId, cursor/pageToken, pageSize
 */
mediaImportRouter.get(`${BASE}/:integrationId/files`, async (req, res, next) => {
  try {
    const { integrationId } = req.params;
    const { path, folderId, cursor, pageToken, pageSize } = req.query;

    const result = await listFiles(req.user.id, integrationId, {
      path,
      folderId,
      cursor,
      pageToken,
      pageSize: pageSize ? parseInt(pageSize) : undefined,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/integrations/media-import/:integrationId/import
 * Body: { fileRef, clientId }
 * Downloads file from provider → uploads to Cloudinary → creates MediaAsset.
 */
mediaImportRouter.post(`${BASE}/:integrationId/import`, async (req, res, next) => {
  try {
    const { integrationId } = req.params;
    const { fileRef, clientId } = req.body;

    if (!fileRef || !clientId) {
      return res.status(400).json({ error: "fileRef and clientId are required" });
    }

    const asset = await importFile(req.user.id, integrationId, fileRef, clientId);
    res.status(201).json({ asset });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/integrations/media-import/:integrationId/disconnect
 * Deactivates the integration (doesn't delete — preserves logs).
 */
mediaImportRouter.delete(`${BASE}/:integrationId/disconnect`, async (req, res, next) => {
  try {
    const { integrationId } = req.params;

    const result = await prisma.integration.updateMany({
      where: { id: integrationId, userId: req.user.id },
      data: { isActive: false },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: "Integration not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
