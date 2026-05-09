// Fetch the LinkedIn Organization Pages the connected member can
// administer. Used immediately after the
// LINKEDIN_ORGANIZATION_PAGE OAuth callback to drive a page-picker UI.
//
// We intentionally show only orgs where the member has an admin
// role; LinkedIn returns more roles than that (recruiter, analytics,
// etc.) and they can't post. Filtering keeps the UI honest.
//
// Endpoint:
//   GET /v2/organizationalEntityAcls
//     ?q=roleAssignee
//     &role=ADMINISTRATOR
//     &state=APPROVED
//     &projection=(elements*(*,organization~(id,localizedName,vanityName,logoV2(original~:playableStreams))))
//
// The CMS + Page roles vary per org. Per LinkedIn docs the roles
// allowed to publish via Posts API as the org are ADMINISTRATOR and
// (via the CMS Page Admin grant) DIRECT_SPONSORED_CONTENT_POSTER.
// We start with ADMINISTRATOR — that's the universal one — and let
// callers pass an override role list if they need a wider net.

import { prisma } from "../../prisma.js";
import { decryptToken } from "../../lib/tokenCrypto.js";

const LI_REST = "https://api.linkedin.com/v2";

const HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "X-Restli-Protocol-Version": "2.0.0",
});

class LinkedInOrgPagesError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "LinkedInOrgPagesError";
    this.status = status ?? 502;
    this.code = code ?? "LINKEDIN_ORG_PAGES_FETCH_FAILED";
    this.body = body ?? null;
  }
}

/**
 * Fetch admin-eligible Organization Pages for a stored connection.
 * Returns [{ id, urn, name, vanityName, logoUrl }, ...].
 *
 * Does NOT update the connection — that's the caller's responsibility
 * once the user picks a specific page (see saveSelectedOrganization
 * below).
 */
export async function listManageableOrganizations({ connectionId }) {
  const conn = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, channel: true, accessToken: true, status: true },
  });
  if (!conn) {
    throw new LinkedInOrgPagesError("Connection not found", { status: 404, code: "NOT_FOUND" });
  }
  if (conn.channel !== "LINKEDIN_ORGANIZATION_PAGE") {
    throw new LinkedInOrgPagesError(
      "Connection is not a LinkedIn Organization Page connection",
      { status: 400, code: "WRONG_CHANNEL" }
    );
  }
  if (conn.status !== "CONNECTED") {
    throw new LinkedInOrgPagesError(
      "LinkedIn Organization Page connection is not active. Please reconnect.",
      { status: 400, code: "CONNECTION_NOT_ACTIVE" }
    );
  }

  const token = decryptToken(conn.accessToken);

  const url =
    `${LI_REST}/organizationalEntityAcls` +
    `?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED` +
    `&projection=(elements*(*,organization~(id,localizedName,vanityName,logoV2(original~:playableStreams))))`;

  const res = await fetch(url, { headers: HEADERS(token) });
  if (res.status === 401 || res.status === 403) {
    // Token doesn't carry r_organization_admin (most likely Community
    // Management API approval still pending). Surface this in
    // user-facing wording rather than leak LinkedIn's copy.
    throw new LinkedInOrgPagesError(
      "LinkedIn Organization Page access is not approved for this app yet. " +
        "Once Community Management API approval lands, reconnect to grant the org-admin scope.",
      { status: 403, code: "PROVIDER_PERMISSION_DENIED", body: null }
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new LinkedInOrgPagesError(
      body?.message ?? `LinkedIn org-acls fetch failed (${res.status})`,
      { status: res.status, body }
    );
  }

  // Response shape: { elements: [{ organization: "urn:li:organization:<id>",
  //                                 organization~: { id, localizedName, vanityName, logoV2 } }], ... }
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  return elements
    .map((el) => {
      const orgUrn = el.organization;
      const orgInfo = el["organization~"] ?? {};
      const id = orgInfo.id;
      if (!id || !orgUrn) return null;
      const logoStreams =
        orgInfo?.logoV2?.["original~"]?.elements?.[0]?.identifiers ?? [];
      const logoUrl = logoStreams[0]?.identifier ?? null;
      return {
        id: String(id),
        urn: orgUrn,
        name: orgInfo.localizedName ?? `Organization ${id}`,
        vanityName: orgInfo.vanityName ?? null,
        logoUrl,
      };
    })
    .filter(Boolean);
}

/**
 * Persist the user's chosen organization on the connection. Stores
 * the org URN in externalAccountId (so the publishing adapter can read
 * it without an extra lookup) and updates displayName for the channels
 * UI label.
 *
 * Caller must verify the connection belongs to the requesting workspace
 * — done at the route layer via requireClientOwner / connection ownership.
 */
export async function saveSelectedOrganization({ connectionId, organizationId, organizationName }) {
  if (!organizationId) {
    throw new LinkedInOrgPagesError("organizationId is required", {
      status: 400,
      code: "MISSING_ORGANIZATION_ID",
    });
  }
  return prisma.channelConnection.update({
    where: { id: connectionId },
    data: {
      externalAccountId: `urn:li:organization:${organizationId}`,
      displayName: organizationName ?? null,
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
