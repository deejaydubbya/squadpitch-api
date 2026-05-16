// Google Business Profile location picker.
//
// After OAuth completes, the ChannelConnection holds the user's
// access + refresh tokens but externalAccountId is just
// "accounts/{a}" — a sentinel meaning "still needs a location."
// The polling worker + reply send service both refuse to act
// on connections whose externalAccountId doesn't contain
// "/locations/", so a half-finished connection cannot fire.
//
// This service:
//   1. listLocations() — walks all GBP accounts the token can see,
//      pulls each one's locations, returns a flat picker list.
//   2. saveSelectedLocation() — stamps the chosen location resource
//      name onto ChannelConnection.externalAccountId so the poller
//      knows which location to fetch reviews from.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";
import {
  listAccounts,
  listLocationsForAccount,
} from "./oauth/googleBusinessProfile.oauth.js";

class GbpLocationsError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "GbpLocationsError";
    this.status = status ?? 502;
    this.code = code ?? "GBP_LOCATIONS_FETCH_FAILED";
    this.body = body ?? null;
  }
}

async function loadConnection(connectionId) {
  const conn = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      clientId: true,
      channel: true,
      accessToken: true,
      status: true,
      externalAccountId: true,
      displayName: true,
    },
  });
  if (!conn) {
    throw new GbpLocationsError("Connection not found", {
      status: 404,
      code: "NOT_FOUND",
    });
  }
  if (conn.channel !== "GOOGLE_BUSINESS_PROFILE") {
    throw new GbpLocationsError("Connection is not a Google Business Profile connection", {
      status: 400,
      code: "WRONG_CHANNEL",
    });
  }
  if (conn.status !== "CONNECTED") {
    throw new GbpLocationsError("Connection is not active. Reconnect Google Business Profile.", {
      status: 400,
      code: "CONNECTION_NOT_ACTIVE",
    });
  }
  return conn;
}

/**
 * Fetch every location across every GBP account the token can see.
 * Returns a flat array suitable for a picker UI.
 *   [{ name, title, address, accountName, accountId }, ...]
 *
 * `name` is the canonical resource string Google expects
 * everywhere ("accounts/{a}/locations/{l}") — that's what gets
 * stamped onto externalAccountId on selection.
 */
export async function listLocations({ connectionId }) {
  const conn = await loadConnection(connectionId);
  const token = decryptToken(conn.accessToken);

  const accounts = await listAccounts({ accessToken: token });
  if (accounts.length === 0) return [];

  const result = [];
  for (const acc of accounts) {
    if (!acc?.name) continue;
    const accountName =
      typeof acc.accountName === "string"
        ? acc.accountName
        : typeof acc.displayName === "string"
          ? acc.displayName
          : acc.name;
    let locations = [];
    try {
      locations = await listLocationsForAccount({
        accessToken: token,
        accountName: acc.name,
      });
    } catch (err) {
      console.warn(
        `[gbp.locations] listLocationsForAccount failed for ${acc.name}:`,
        err?.message,
      );
      continue;
    }
    for (const loc of locations) {
      if (!loc?.name || typeof loc.name !== "string") continue;
      // Google returns locations in "locations/{l}" form scoped
      // to the account in the URL — but our externalAccountId
      // needs the FULL "accounts/{a}/locations/{l}" canonical
      // form so the poller can call the v4 reviews endpoint.
      const canonicalName = loc.name.startsWith("accounts/")
        ? loc.name
        : `${acc.name}/${loc.name}`;
      result.push({
        name: canonicalName,
        title: typeof loc.title === "string" ? loc.title : null,
        address: formatAddress(loc.storefrontAddress),
        accountId: acc.name,
        accountName,
      });
    }
  }
  return result;
}

/**
 * Stamp the chosen location onto the connection. Updates BOTH
 * externalAccountId (so the poller + reply send know which
 * location to act on) and displayName (so the UI shows the
 * location title rather than the bare account name).
 */
export async function saveSelectedLocation({ connectionId, locationName, locationTitle }) {
  if (!locationName || typeof locationName !== "string") {
    throw new GbpLocationsError("locationName is required", {
      status: 400,
      code: "MISSING_LOCATION_NAME",
    });
  }
  if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(locationName)) {
    throw new GbpLocationsError(
      "locationName must look like 'accounts/{accountId}/locations/{locationId}'",
      { status: 400, code: "MALFORMED_LOCATION_NAME" },
    );
  }
  // Loads + validates the connection is a CONNECTED GBP row.
  const conn = await loadConnection(connectionId);

  // Preserve the original account-level displayName as a prefix
  // so the connection card reads "Acme Co · Acme Co — Downtown".
  // Falls back to just the location title if no original.
  const accountName = conn.displayName ?? null;
  const trimmedTitle =
    typeof locationTitle === "string" && locationTitle.trim().length > 0
      ? locationTitle.trim()
      : null;
  const newDisplayName = trimmedTitle
    ? accountName
      ? `${accountName} · ${trimmedTitle}`
      : trimmedTitle
    : accountName;

  return prisma.channelConnection.update({
    where: { id: conn.id },
    data: {
      externalAccountId: locationName,
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

function formatAddress(storefrontAddress) {
  if (!storefrontAddress || typeof storefrontAddress !== "object") return null;
  const parts = [];
  if (Array.isArray(storefrontAddress.addressLines)) {
    for (const line of storefrontAddress.addressLines) {
      if (typeof line === "string" && line.trim()) parts.push(line.trim());
    }
  }
  const cityState = [
    typeof storefrontAddress.locality === "string" ? storefrontAddress.locality : null,
    typeof storefrontAddress.administrativeArea === "string"
      ? storefrontAddress.administrativeArea
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (cityState) parts.push(cityState);
  if (typeof storefrontAddress.postalCode === "string") parts.push(storefrontAddress.postalCode);
  return parts.length > 0 ? parts.join(", ") : null;
}
