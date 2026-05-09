// Pinterest boards picker.
//
// After a successful Pinterest OAuth callback, the user has a
// CONNECTED row but no destination yet. This service:
//   1. listBoards()      — fetches boards from Pinterest, paginating
//                          if Pinterest returns a bookmark cursor.
//                          Used by the picker UI.
//   2. saveSelectedBoard() — stamps the chosen board id onto
//                            ChannelConnection.externalAccountId so
//                            the publishing adapter knows which board
//                            to author Pins on. The Pinterest username
//                            is preserved on displayName so the
//                            connection card still shows "@user · BoardName".
//
// Pinterest API v5: GET /v5/boards
//   Query: page_size (default 25, max 100), bookmark (pagination cursor)
//   Response: { items: [{ id, name, description?, privacy, … }], bookmark? }

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import { pinterestApiUrl } from "./oauth/pinterestApi.js";

const PAGE_SIZE = 100; // max allowed; we collect all pages

class PinterestBoardsError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "PinterestBoardsError";
    this.status = status ?? 502;
    this.code = code ?? "PINTEREST_BOARDS_FETCH_FAILED";
    this.body = body ?? null;
  }
}

/**
 * Fetch all boards visible to the connected Pinterest account.
 * Returns [{ id, name, description, privacy }, ...].
 */
export async function listBoards({ connectionId }) {
  const conn = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, channel: true, accessToken: true, status: true },
  });
  if (!conn) {
    throw new PinterestBoardsError("Connection not found", {
      status: 404,
      code: "NOT_FOUND",
    });
  }
  if (conn.channel !== "PINTEREST") {
    throw new PinterestBoardsError(
      "Connection is not a Pinterest connection",
      { status: 400, code: "WRONG_CHANNEL" }
    );
  }
  if (conn.status !== "CONNECTED") {
    throw new PinterestBoardsError(
      "Pinterest connection is not active. Please reconnect.",
      { status: 400, code: "CONNECTION_NOT_ACTIVE" }
    );
  }

  const token = decryptToken(conn.accessToken);

  const boards = [];
  let bookmark = null;
  // Cap iterations so a malformed cursor never spins forever.
  for (let page = 0; page < 20; page++) {
    const url = new URL(pinterestApiUrl("/v5/boards"));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (bookmark) url.searchParams.set("bookmark", bookmark);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));

    if (res.status === 401 || res.status === 403) {
      throw new PinterestBoardsError(
        "Pinterest needs to be reconnected with board access.",
        { status: 403, code: "PROVIDER_PERMISSION_DENIED", body: null }
      );
    }
    if (res.status === 429) {
      throw new PinterestBoardsError("Pinterest is rate-limiting board lookups. Try again shortly.", {
        status: 429,
        code: "PROVIDER_RATE_LIMITED",
      });
    }
    if (!res.ok) {
      throw new PinterestBoardsError(
        body?.message ?? `Pinterest boards fetch failed (${res.status})`,
        { status: res.status, body }
      );
    }

    const items = Array.isArray(body?.items) ? body.items : [];
    for (const b of items) {
      if (!b?.id) continue;
      boards.push({
        id: String(b.id),
        name: b.name ?? "Untitled board",
        description: b.description ?? null,
        privacy: b.privacy ?? null,
      });
    }
    bookmark = body?.bookmark ?? null;
    if (!bookmark) break;
  }

  return boards;
}

/**
 * Persist the selected board id on the Pinterest connection. The
 * publishing adapter reads this directly to know where to send Pins.
 *
 * displayName is updated to "<username> · <board name>" so the
 * Channels card shows the operator-meaningful destination at a glance,
 * matching the LinkedIn Organization Page pattern.
 */
export async function saveSelectedBoard({
  connectionId,
  boardId,
  boardName,
}) {
  if (!boardId || typeof boardId !== "string") {
    throw new PinterestBoardsError("boardId is required", {
      status: 400,
      code: "MISSING_BOARD_ID",
    });
  }

  const existing = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { displayName: true },
  });
  // Preserve the @username prefix if displayName already starts with one;
  // otherwise just record the board name.
  const username = existing?.displayName?.split(" · ")[0] ?? null;
  const newDisplayName = boardName
    ? username
      ? `${username} · ${boardName}`
      : boardName
    : username ?? null;

  return prisma.channelConnection.update({
    where: { id: connectionId },
    data: {
      externalAccountId: boardId,
      displayName: newDisplayName,
      lastValidatedAt: new Date(),
    },
    select: {
      id: true,
      channel: true,
      externalAccountId: true,
      displayName: true,
      status: true,
    },
  });
}
