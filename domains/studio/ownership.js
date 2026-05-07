// Ownership middleware extracted into its own module so tests can
// import without booting the giant studio.routes module (which pulls in
// every service and would slow each test to a crawl).

import { prisma } from "../../prisma.js";
import { sendError } from "../../lib/apiErrors.js";
import { getAuth0Sub } from "../../middleware/auth.js";

// Verifies the client identified by req.params.id (or req.params.clientId)
// belongs to the authenticated user.
export async function requireClientOwner(req, res, next) {
  try {
    const clientId = req.params.id || req.params.clientId;
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { createdBy: true },
    });
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    if (client.createdBy !== getAuth0Sub(req)) {
      req.log?.warn(
        { clientId, owner: client.createdBy, actor: getAuth0Sub(req) },
        "client_owner_mismatch"
      );
      return sendError(res, 403, "FORBIDDEN", "Forbidden");
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Verifies the draft's parent client belongs to the authenticated user.
// Returns 404 on missing or mismatch (avoids leaking resource existence).
export async function requireDraftOwner(req, res, next) {
  try {
    const draftId = req.params.id;
    if (!draftId) return sendError(res, 400, "MISSING_DRAFT_ID", "Missing draft id");
    const draft = await prisma.draft.findUnique({
      where: { id: draftId },
      select: { id: true, clientId: true, client: { select: { createdBy: true } } },
    });
    if (!draft) return sendError(res, 404, "NOT_FOUND", "Draft not found");
    if (draft.client?.createdBy !== getAuth0Sub(req)) {
      req.log?.warn(
        { draftId, owner: draft.client?.createdBy, actor: getAuth0Sub(req) },
        "draft_owner_mismatch"
      );
      return sendError(res, 404, "NOT_FOUND", "Draft not found");
    }
    req.draft = { id: draft.id, clientId: draft.clientId };
    next();
  } catch (err) {
    next(err);
  }
}

// Verifies the asset's parent client belongs to the authenticated user.
// Used by /api/v1/assets/:assetId/* direct routes.
export async function requireAssetOwner(req, res, next) {
  try {
    const assetId = req.params.assetId || req.params.id;
    if (!assetId) return sendError(res, 400, "MISSING_ASSET_ID", "Missing asset id");
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: assetId },
      select: { id: true, clientId: true, client: { select: { createdBy: true } } },
    });
    if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");
    if (asset.client?.createdBy !== getAuth0Sub(req)) {
      req.log?.warn(
        { assetId, owner: asset.client?.createdBy, actor: getAuth0Sub(req) },
        "asset_owner_mismatch"
      );
      return sendError(res, 404, "NOT_FOUND", "Asset not found");
    }
    req.asset = { id: asset.id, clientId: asset.clientId };
    next();
  } catch (err) {
    next(err);
  }
}

// Body-clientId guard: routes that take `clientId` in `req.body` must
// verify the requester owns that client BEFORE doing anything else.
// Returns a middleware bound to the body field name (default "clientId").
// On success attaches `req.bodyClient = { id, createdBy }`.
export function requireBodyClientOwner(field = "clientId") {
  return async function (req, res, next) {
    try {
      const clientId = req.body?.[field];
      if (!clientId || typeof clientId !== "string") {
        return sendError(res, 400, "MISSING_CLIENT_ID", `Missing ${field}`);
      }
      const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true, createdBy: true },
      });
      if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
      if (client.createdBy !== getAuth0Sub(req)) {
        req.log?.warn(
          { clientId, owner: client.createdBy, actor: getAuth0Sub(req), field },
          "body_client_owner_mismatch"
        );
        // 404 (not 403) to avoid leaking workspace existence via id probing.
        return sendError(res, 404, "NOT_FOUND", "Client not found");
      }
      req.bodyClient = client;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Inline (non-middleware) variant of requireBodyClientOwner — returns
// null on success, or { status, code, message } on failure. Lets a
// route handler do the check inside its existing try/catch without
// reshaping into a middleware chain.
export async function assertClientOwnedByCurrentUser(clientId, req) {
  if (!clientId || typeof clientId !== "string") {
    return { status: 400, code: "MISSING_CLIENT_ID", message: "Missing clientId" };
  }
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, createdBy: true },
  });
  if (!client) {
    return { status: 404, code: "NOT_FOUND", message: "Client not found" };
  }
  if (client.createdBy !== getAuth0Sub(req)) {
    req.log?.warn(
      { clientId, owner: client.createdBy, actor: getAuth0Sub(req) },
      "body_client_owner_mismatch"
    );
    return { status: 404, code: "NOT_FOUND", message: "Client not found" };
  }
  return null;
}

// Helper: assert that a draftId, if present, belongs to the given
// client. Returns null on absent input. Throws a typed error otherwise.
export async function assertDraftInClient(draftId, clientId) {
  if (!draftId) return null;
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { id: true, clientId: true },
  });
  if (!draft || draft.clientId !== clientId) {
    const err = new Error("Draft does not belong to this workspace");
    err.status = 404;
    err.code = "DRAFT_NOT_FOUND";
    throw err;
  }
  return draft;
}

// Helper: assert that a folderId, if present, belongs to the given client.
export async function assertFolderInClient(folderId, clientId) {
  if (!folderId) return null;
  const folder = await prisma.assetFolder.findUnique({
    where: { id: folderId },
    select: { id: true, clientId: true },
  });
  if (!folder || folder.clientId !== clientId) {
    const err = new Error("Folder does not belong to this workspace");
    err.status = 404;
    err.code = "FOLDER_NOT_FOUND";
    throw err;
  }
  return folder;
}

// Helper: assert that an assetId, if present, belongs to the given
// client. Used by persona compose/blend routes that accept asset IDs
// in the body — the user must own the source asset's workspace.
export async function assertAssetInClient(assetId, clientId) {
  if (!assetId) return null;
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { id: true, clientId: true },
  });
  if (!asset || asset.clientId !== clientId) {
    const err = new Error("Asset does not belong to this workspace");
    err.status = 404;
    err.code = "ASSET_NOT_FOUND";
    throw err;
  }
  return asset;
}

// Helper: assert that a dataItemId, if present, belongs to the given
// client. WorkspaceDataItem carries clientId directly.
export async function assertDataItemInClient(dataItemId, clientId) {
  if (!dataItemId) return null;
  const item = await prisma.workspaceDataItem.findUnique({
    where: { id: dataItemId },
    select: { id: true, clientId: true },
  });
  if (!item || item.clientId !== clientId) {
    const err = new Error("Data item does not belong to this workspace");
    err.status = 404;
    err.code = "DATA_ITEM_NOT_FOUND";
    throw err;
  }
  return item;
}

// Cross-resource guard: when an asset is being attached/linked to a
// draft via /api/v1/assets/:assetId/(attach|link)/:draftId, both must
// belong to the same client AND that client must be owned by the
// requester. Runs AFTER requireAssetOwner so we know the asset is owned.
export async function requireAssetAndDraftSameWorkspace(req, res, next) {
  try {
    const draftId = req.params.draftId || req.body?.draftId;
    if (!draftId) {
      return sendError(res, 400, "MISSING_DRAFT_ID", "Missing draft id");
    }
    const draft = await prisma.draft.findUnique({
      where: { id: draftId },
      select: { id: true, clientId: true, client: { select: { createdBy: true } } },
    });
    if (!draft) return sendError(res, 404, "NOT_FOUND", "Draft not found");
    if (draft.client?.createdBy !== getAuth0Sub(req)) {
      req.log?.warn(
        { draftId, owner: draft.client?.createdBy, actor: getAuth0Sub(req) },
        "draft_owner_mismatch"
      );
      return sendError(res, 404, "NOT_FOUND", "Draft not found");
    }
    if (req.asset && req.asset.clientId !== draft.clientId) {
      req.log?.warn(
        {
          assetId: req.asset.id,
          assetClient: req.asset.clientId,
          draftId,
          draftClient: draft.clientId,
        },
        "cross_workspace_link_blocked"
      );
      return sendError(
        res,
        403,
        "CROSS_WORKSPACE_FORBIDDEN",
        "Asset and draft must belong to the same workspace"
      );
    }
    req.draft = { id: draft.id, clientId: draft.clientId };
    next();
  } catch (err) {
    next(err);
  }
}
