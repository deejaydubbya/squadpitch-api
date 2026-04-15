// CRM Sync Service — ingests data from Follow Up Boss (and future CRMs)
// into WorkspaceDataItems for content generation.
//
// Content signals derived:
// - Closed deals → MILESTONE ("Just Sold" posts)
// - Client feedback from notes → TESTIMONIAL
// - Under contract → EVENT (marketing opportunities)
// - Repeat clients → CASE_STUDY material
//
// Data flow:
//   CRM API → derive content signals → deduplicate → WorkspaceDataItems

import { prisma } from "../../prisma.js";
import * as fubProvider from "../integrations/providers/fubProvider.js";
import { stampSourceAttribution } from "../industry/realEstateAssets.js";

const CRM_SOURCE_TYPE = "crm";

// ── Sync ────────────────────────────────────────────────────────────────

/**
 * Full sync: fetch deals + contacts from CRM and derive content signals.
 *
 * @param {string} clientId — workspace ID
 * @returns {Promise<{ dealsImported: number, testimonialsImported: number, milestonesImported: number, signals: object[] }>}
 */
export async function syncCRM(clientId) {
  const connection = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId: clientId, providerKey: "real_estate_crm" } },
  });

  if (!connection || connection.connectionStatus !== "connected") {
    throw Object.assign(new Error("CRM not connected"), { status: 400 });
  }

  const config = connection.metadataJson || {};
  if (!config.apiKey) {
    throw Object.assign(new Error("CRM API key missing — reconnect required"), { status: 400 });
  }

  const lastSyncedAt = config.lastSyncedAt || null;
  const dataSource = await getOrCreateCRMSource(clientId);

  let dealsImported = 0;
  let testimonialsImported = 0;
  let milestonesImported = 0;
  const signals = [];

  try {
    // 1. Fetch deals (focus on closed and under contract)
    const { deals } = await fubProvider.fetchDeals(config, {
      limit: 100,
      updatedAfter: lastSyncedAt,
    });

    for (const deal of deals) {
      // Closed deals → MILESTONE ("Just Sold")
      if (isClosedDeal(deal)) {
        const result = await upsertMilestone(clientId, dataSource.id, deal);
        if (result === "created") {
          milestonesImported++;
          signals.push({
            type: "just_sold",
            message: `Closed deal: ${deal.address || deal.personName || "New sale"}`,
            dealId: deal.id,
          });
        }
      }

      // Under contract → EVENT (marketing opportunity)
      if (isUnderContract(deal)) {
        signals.push({
          type: "under_contract",
          message: `Under contract: ${deal.address || deal.personName}`,
          dealId: deal.id,
        });
      }
    }

    // 2. Fetch recent contacts — look for testimonial signals
    const { people } = await fubProvider.fetchPeople(config, {
      limit: 50,
      updatedAfter: lastSyncedAt,
    });

    // For closed deal contacts, check notes for testimonial material
    const closedContacts = people.filter(
      (p) => p.stage && ["Closed", "Past Client"].includes(p.stage)
    );

    for (const contact of closedContacts.slice(0, 20)) {
      try {
        const { notes } = await fubProvider.fetchNotes(config, contact.id, { limit: 10 });
        const testimonialNotes = notes.filter(isTestimonialNote);

        for (const note of testimonialNotes.slice(0, 2)) {
          const result = await upsertTestimonial(clientId, dataSource.id, contact, note);
          if (result === "created") {
            testimonialsImported++;
            signals.push({
              type: "happy_client",
              message: `Positive feedback from ${contact.name}`,
              contactId: contact.id,
            });
          }
        }
      } catch {
        // Skip individual note fetch failures
      }
    }

    // 3. Update connection metadata
    await prisma.workspaceTechStackConnection.update({
      where: { id: connection.id },
      data: {
        metadataJson: {
          ...config,
          lastSyncedAt: new Date().toISOString(),
          dealCount: deals.length,
          contactCount: people.length,
        },
      },
    });
  } catch (err) {
    if (err.permanent) {
      await prisma.workspaceTechStackConnection.update({
        where: { id: connection.id },
        data: {
          connectionStatus: "error",
          lastError: err.message,
          metadataJson: { ...config, lastSyncedAt: new Date().toISOString() },
        },
      });
    }
    throw err;
  }

  return { dealsImported: milestonesImported, testimonialsImported, milestonesImported, signals };
}

// ── Milestone Processing (Closed Deals) ─────────────────────────────────

async function upsertMilestone(clientId, dataSourceId, deal) {
  const externalId = `fub_deal_${deal.id}`;

  const existing = await prisma.workspaceDataItem.findFirst({
    where: {
      clientId,
      type: "MILESTONE",
      status: "ACTIVE",
      dataJson: { path: ["_externalId"], equals: externalId },
    },
  });

  const dataJson = stampSourceAttribution(
    {
      achievement: "Just Sold",
      dealType: deal.dealType || "Sale",
      address: deal.address || null,
      price: deal.price || null,
      closingDate: deal.closingDate || null,
      clientName: deal.personName || null,
      _externalId: externalId,
    },
    CRM_SOURCE_TYPE,
    {}
  );

  const title = deal.address
    ? `Just Sold: ${deal.address}`
    : `Closed Deal${deal.personName ? ` with ${deal.personName}` : ""}`;

  const summaryParts = [];
  if (deal.price) summaryParts.push(`$${Number(deal.price).toLocaleString()}`);
  if (deal.address) summaryParts.push(deal.address);
  if (deal.closingDate) summaryParts.push(`Closed ${deal.closingDate}`);
  const summary = summaryParts.join(" · ") || "Deal closed";

  const tags = ["just-sold", "crm"];
  if (deal.dealType) tags.push(deal.dealType.toLowerCase());

  if (existing) {
    await prisma.workspaceDataItem.update({
      where: { id: existing.id },
      data: { title, summary, dataJson, tags, priority: 8 },
    });
    return "updated";
  }

  await prisma.workspaceDataItem.create({
    data: {
      clientId,
      dataSourceId,
      type: "MILESTONE",
      title,
      summary,
      dataJson,
      tags,
      priority: 8,
    },
  });
  return "created";
}

// ── Testimonial Processing (from Notes) ─────────────────────────────────

async function upsertTestimonial(clientId, dataSourceId, contact, note) {
  const externalId = `fub_note_${note.id}`;

  const existing = await prisma.workspaceDataItem.findFirst({
    where: {
      clientId,
      type: "TESTIMONIAL",
      status: "ACTIVE",
      dataJson: { path: ["_externalId"], equals: externalId },
    },
  });

  const dataJson = stampSourceAttribution(
    {
      quote: note.body,
      author: contact.name,
      _externalId: externalId,
      contactId: contact.id,
      contactEmail: contact.email,
    },
    CRM_SOURCE_TYPE,
    {}
  );

  const title = `Testimonial from ${contact.name}`;
  const summary = note.body.slice(0, 200);
  const tags = ["testimonial", "crm", "client-feedback"];

  if (existing) {
    await prisma.workspaceDataItem.update({
      where: { id: existing.id },
      data: { title, summary, dataJson, tags, priority: 7 },
    });
    return "updated";
  }

  await prisma.workspaceDataItem.create({
    data: {
      clientId,
      dataSourceId,
      type: "TESTIMONIAL",
      title,
      summary,
      dataJson,
      tags,
      priority: 7,
    },
  });
  return "created";
}

// ── Signal Detection ────────────────────────────────────────────────────

function isClosedDeal(deal) {
  if (!deal.stage) return false;
  const lower = deal.stage.toLowerCase();
  return lower === "closed" || lower === "sold" || lower.includes("closed");
}

function isUnderContract(deal) {
  if (!deal.stage) return false;
  const lower = deal.stage.toLowerCase();
  return lower === "under contract" || lower.includes("contract") || lower === "pending";
}

/**
 * Detect if a note contains testimonial-worthy content.
 * Looks for positive sentiment signals.
 */
function isTestimonialNote(note) {
  if (!note.body || note.body.length < 30) return false;

  const lower = note.body.toLowerCase();
  const positiveSignals = [
    "thank", "great experience", "amazing", "wonderful",
    "recommend", "happy", "love", "perfect", "excellent",
    "fantastic", "appreciate", "smooth", "easy process",
    "best agent", "five star", "5 star", "couldn't be happier",
    "above and beyond", "so glad", "very pleased", "very happy",
  ];

  return positiveSignals.some((signal) => lower.includes(signal));
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function getOrCreateCRMSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "URL", name: "CRM Import" },
  });
  if (existing) return existing;
  return prisma.workspaceDataSource.create({
    data: { clientId, type: "URL", name: "CRM Import" },
  });
}
