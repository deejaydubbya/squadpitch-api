// Unit tests for the campaign-backfill helpers — the pure
// functions that turn a Draft group into a Campaign row's shape.
// We don't exercise the script's prisma calls here; those are
// integration concerns. These tests lock down the parsing /
// status-inference / source-title logic the script delegates to.

import { describe, it, expect } from "vitest";
import {
  parseDraftSourceMeta,
  sourceTitleForDisplay,
} from "../domains/studio/draftSourceMeta.server.js";
import {
  inferStatusFromDraftStatuses,
  initialCampaignStatus,
  formatCampaign,
} from "../domains/studio/campaign.service.js";

describe("parseDraftSourceMeta", () => {
  it("returns the empty shape for null/empty warnings", () => {
    expect(parseDraftSourceMeta(null).sourceType).toBeNull();
    expect(parseDraftSourceMeta([]).sourceType).toBeNull();
    expect(parseDraftSourceMeta(undefined).sourceType).toBeNull();
  });

  it("reads source attribution tags from a campaign-save warnings array", () => {
    const meta = parseDraftSourceMeta([
      "source:property",
      "campaignType:just_listed",
      "campaignNameRoot:508 King George Court",
      "address:508 King George Court",
      "sourceTitle:508 King George Court",
      "dataItemId:item_abc123",
      "angle:promotional",
    ]);
    expect(meta.sourceType).toBe("property");
    expect(meta.campaignType).toBe("just_listed");
    expect(meta.address).toBe("508 King George Court");
    expect(meta.dataItemId).toBe("item_abc123");
    expect(meta.isAutopilot).toBe(false);
  });

  it("normalizes legacy source aliases ('listing' → 'property')", () => {
    const meta = parseDraftSourceMeta(["source:listing"]);
    expect(meta.sourceType).toBe("property");
  });

  it("detects autopilot tags", () => {
    const meta = parseDraftSourceMeta([
      "autopilot: true",
      "autopilot_trigger: new_listing",
      "source:listing",
    ]);
    expect(meta.isAutopilot).toBe(true);
    expect(meta.sourceType).toBe("property");
  });

  it("parses idea sources", () => {
    const meta = parseDraftSourceMeta([
      "source:idea",
      "campaignIdea:Promote our spring offer",
      "campaignNameRoot:Promote our spring offer",
    ]);
    expect(meta.sourceType).toBe("idea");
    expect(meta.campaignIdea).toBe("Promote our spring offer");
  });

  it("returns null for unknown source tag values", () => {
    expect(parseDraftSourceMeta(["source:garbage"]).sourceType).toBeNull();
  });
});

describe("sourceTitleForDisplay", () => {
  it("prefers address for property sources", () => {
    const title = sourceTitleForDisplay({
      sourceType: "property",
      address: "508 King George Court",
      sourceTitle: "508 King George Court",
      campaignNameRoot: "508 King George Court",
    });
    expect(title).toBe("508 King George Court");
  });

  it("falls through to campaignNameRoot when address is missing", () => {
    const title = sourceTitleForDisplay({
      sourceType: "property",
      address: null,
      sourceTitle: null,
      campaignNameRoot: "Listing X",
    });
    expect(title).toBe("Listing X");
  });

  it("uses sourceTitle for data_item", () => {
    const title = sourceTitleForDisplay({
      sourceType: "data_item",
      sourceTitle: "Spring buyer guide",
      campaignNameRoot: "Spring buyer guide",
    });
    expect(title).toBe("Spring buyer guide");
  });

  it("uses campaignIdea for idea", () => {
    const title = sourceTitleForDisplay({
      sourceType: "idea",
      campaignIdea: "Promote spring offer",
    });
    expect(title).toBe("Promote spring offer");
  });

  it("returns null for an unknown shape", () => {
    expect(sourceTitleForDisplay(null)).toBeNull();
    expect(sourceTitleForDisplay({})).toBeNull();
  });
});

describe("inferStatusFromDraftStatuses", () => {
  it("returns DRAFT for an empty group", () => {
    expect(inferStatusFromDraftStatuses([])).toBe("DRAFT");
    expect(inferStatusFromDraftStatuses(null)).toBe("DRAFT");
  });

  it("returns PUBLISHED when every draft is PUBLISHED", () => {
    const drafts = [
      { status: "PUBLISHED" },
      { status: "PUBLISHED" },
      { status: "PUBLISHED" },
    ];
    expect(inferStatusFromDraftStatuses(drafts)).toBe("PUBLISHED");
  });

  it("returns FAILED when every draft is FAILED", () => {
    expect(
      inferStatusFromDraftStatuses([{ status: "FAILED" }, { status: "FAILED" }]),
    ).toBe("FAILED");
  });

  it("returns PUBLISHING when some posts are published and others scheduled", () => {
    expect(
      inferStatusFromDraftStatuses([
        { status: "PUBLISHED" },
        { status: "SCHEDULED" },
      ]),
    ).toBe("PUBLISHING");
  });

  it("returns SCHEDULED when every draft is scheduled", () => {
    expect(
      inferStatusFromDraftStatuses([
        { status: "SCHEDULED" },
        { status: "SCHEDULED" },
      ]),
    ).toBe("SCHEDULED");
  });

  it("returns PENDING_REVIEW when any draft needs review", () => {
    expect(
      inferStatusFromDraftStatuses([
        { status: "DRAFT" },
        { status: "PENDING_REVIEW" },
      ]),
    ).toBe("PENDING_REVIEW");
  });

  it("returns SCHEDULED when partially scheduled (some draft + some scheduled)", () => {
    expect(
      inferStatusFromDraftStatuses([
        { status: "DRAFT" },
        { status: "SCHEDULED" },
      ]),
    ).toBe("SCHEDULED");
  });

  it("falls back to DRAFT for any combo without scheduled/published/pending review", () => {
    expect(
      inferStatusFromDraftStatuses([
        { status: "DRAFT" },
        { status: "APPROVED" },
      ]),
    ).toBe("DRAFT");
  });
});

describe("initialCampaignStatus", () => {
  it("returns SCHEDULED when addToPlanner is true", () => {
    expect(
      initialCampaignStatus({ addToPlanner: true, alwaysRequireReview: true }),
    ).toBe("SCHEDULED");
    expect(
      initialCampaignStatus({ addToPlanner: true, alwaysRequireReview: false }),
    ).toBe("SCHEDULED");
  });

  it("returns PENDING_REVIEW when not auto-planning and review is required", () => {
    expect(
      initialCampaignStatus({ addToPlanner: false, alwaysRequireReview: true }),
    ).toBe("PENDING_REVIEW");
  });

  it("returns DRAFT when not auto-planning and review is opt-out", () => {
    expect(
      initialCampaignStatus({ addToPlanner: false, alwaysRequireReview: false }),
    ).toBe("DRAFT");
  });

  it("defaults missing alwaysRequireReview to true (review-required behavior)", () => {
    expect(initialCampaignStatus({ addToPlanner: false })).toBe(
      "PENDING_REVIEW",
    );
  });
});

describe("formatCampaign", () => {
  const sampleRow = {
    id: "camp_1234567890_abcdef",
    clientId: "client_abc",
    name: "508 King George Court — just listed",
    campaignType: "just_listed",
    sourceType: "property",
    sourceDataItemId: "item_123",
    sourceTitle: "508 King George Court",
    campaignIdea: null,
    status: "SCHEDULED",
    startsAt: new Date("2026-05-13T14:00:00Z"),
    endsAt: new Date("2026-05-20T14:00:00Z"),
    metadataJson: null,
    createdBy: "user_42",
    createdAt: new Date("2026-05-01T10:00:00Z"),
    updatedAt: new Date("2026-05-01T10:00:00Z"),
  };

  it("returns null when row is null", () => {
    expect(formatCampaign(null)).toBeNull();
    expect(formatCampaign(undefined)).toBeNull();
  });

  it("serializes a fully-populated row to ISO date strings", () => {
    const result = formatCampaign(sampleRow);
    expect(result).not.toBeNull();
    expect(result.startsAt).toBe("2026-05-13T14:00:00.000Z");
    expect(result.endsAt).toBe("2026-05-20T14:00:00.000Z");
    expect(result.createdAt).toBe("2026-05-01T10:00:00.000Z");
  });

  it("preserves the canonical fields the web client expects", () => {
    const result = formatCampaign(sampleRow);
    expect(result.id).toBe(sampleRow.id);
    expect(result.clientId).toBe(sampleRow.clientId);
    expect(result.name).toBe(sampleRow.name);
    expect(result.campaignType).toBe("just_listed");
    expect(result.sourceType).toBe("property");
    expect(result.sourceTitle).toBe("508 King George Court");
    expect(result.status).toBe("SCHEDULED");
    expect(result.createdBy).toBe("user_42");
  });

  it("nullifies missing optional fields rather than emitting undefined", () => {
    const minimal = {
      ...sampleRow,
      sourceType: null,
      sourceDataItemId: null,
      sourceTitle: null,
      campaignIdea: null,
      startsAt: null,
      endsAt: null,
      metadataJson: null,
      createdBy: null,
    };
    const result = formatCampaign(minimal);
    expect(result.sourceType).toBeNull();
    expect(result.sourceDataItemId).toBeNull();
    expect(result.sourceTitle).toBeNull();
    expect(result.campaignIdea).toBeNull();
    expect(result.startsAt).toBeNull();
    expect(result.endsAt).toBeNull();
    expect(result.metadataJson).toBeNull();
    expect(result.createdBy).toBeNull();
  });
});
