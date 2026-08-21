import { describe, expect, it } from "vitest";
import { allocateProspectPreviewMedia, buildPropertyMediaPlan, buildVerifiedPropertyFallback, isUsableProspectListing, listingPhotoKey, propertyAssetIdentity, rankPropertyAssets, validateGeneratedPropertyBody, validateProspectComposition } from "../domains/prospects/prospect.service.js";

const item = { title: "10 Main St", dataJson: { street: "10 Main St", city: "Town", state: "OH", zip: "45000", price: 300000, bedrooms: 3, bathrooms: 2, sqft: 1800, yearBuilt: 1990 } };

describe("prospect campaign quality", () => {
  it("produces substantive and distinct safe fallbacks", () => {
    const bodies = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"].map((channel) => buildVerifiedPropertyFallback(item, channel, "Agent Realty"));
    expect(new Set(bodies).size).toBe(3);
    for (const body of bodies) {
      expect(body.length).toBeGreaterThan(180);
      expect(body).toContain("$300,000");
      expect(body).toMatch(/listing|property/i);
      expect(body).not.toMatch(/neighborhood|natural light|modern conveniences|perfect for families/i);
      expect(validateProspectComposition(body)).toEqual({ valid: true });
      expect(validateGeneratedPropertyBody(body, item)).toEqual({ valid: true });
    }
  });

  it("ranks clear main-house exteriors above obstructed views and outbuildings", () => {
    const assets = [
      { id: "shed", tags: ["prospect-scene:garage_outbuilding"], width: 1600, height: 1200 },
      { id: "trees", tags: ["prospect-scene:main_front_exterior", "prospect-obstructed"], width: 1600, height: 1200 },
      { id: "front", tags: ["prospect-scene:main_front_exterior", "prospect-clear-view"], width: 1600, height: 1200 },
    ];
    expect(rankPropertyAssets(assets).map(({ asset }) => asset.id)).toEqual(["front", "trees", "shed"]);
  });

  it("builds distinct platform heroes and duplicate-free coherent galleries", () => {
    const make = (id, scene) => ({ id, tags: [`prospect-scene:${scene}`], width: 1600, height: 1200 });
    const assets = [make("front-1", "main_front_exterior"), make("front-2", "main_front_exterior"), make("front-3", "alternate_exterior"), make("kitchen", "kitchen"), make("living", "living_interior"), make("yard", "yard_land"), make("shed", "garage_outbuilding")];
    const plan = buildPropertyMediaPlan(assets);
    expect(plan.featured.id).toBe("front-1");
    expect([plan.INSTAGRAM[0].id, plan.FACEBOOK[0].id, plan.LINKEDIN[0].id]).toEqual(["front-1", "front-2", "front-3"]);
    expect(plan.INSTAGRAM).toHaveLength(3);
    expect(plan.FACEBOOK).toHaveLength(3);
    expect(plan.LINKEDIN).toHaveLength(1);
    expect(new Set(plan.INSTAGRAM.map(({ id }) => id)).size).toBe(plan.INSTAGRAM.length);
    expect(new Set(plan.INSTAGRAM.map(({ id }) => id))).not.toEqual(new Set(plan.FACEBOOK.map(({ id }) => id)));
  });

  it("prefers useful supporting context over a high-scoring detail for gallery position three", () => {
    const make = (id, scene, qualityScore = 0) => ({ id, tags: [`prospect-scene:${scene}`], width: 1600, height: 1200, qualityScore });
    const plan = buildPropertyMediaPlan([make("front", "main_front_exterior"), make("alternate", "alternate_exterior"), make("front-door", "porch_patio_deck", 10), make("living", "living_interior")]);
    expect(plan.INSTAGRAM.map(({ id }) => id)).toEqual(["front", "alternate", "living"]);
    expect(plan.INSTAGRAM).toHaveLength(3);
    expect(plan.FACEBOOK).toHaveLength(3);
    expect(plan.LINKEDIN).toHaveLength(1);
  });

  it("collapses Coldwell transformation variants to one source photo", () => {
    expect(listingPhotoKey("https://images-listings.coldwellbanker.com/P00_800x600.jpg")).toBe("P00");
    expect(listingPhotoKey("https://images-listings.coldwellbanker.com/P00_1600x1200.jpg")).toBe("P00");
    expect(listingPhotoKey("https://images-listings.coldwellbanker.com/P01_800x600.jpg")).toBe("P01");
    expect(propertyAssetIdentity({ id: "variant-a", url: "https://images-listings.coldwellbanker.com/P00_800x600.jpg?width=800" })).toBe(propertyAssetIdentity({ id: "variant-b", url: "https://images-listings.coldwellbanker.com/P00_1600x1200.jpg?width=1600" }));
    expect(propertyAssetIdentity({ url: "https://images-listings.coldwellbanker.com/listing-a/P00_800x600.jpg" })).not.toBe(propertyAssetIdentity({ url: "https://images-listings.coldwellbanker.com/listing-b/P00_800x600.jpg" }));
  });

  it("allocates distinct canonical images across same-listing posts when inventory permits", () => {
    const assets = [
      { id: "front", url: "https://cdn.test/front.jpg", tags: ["prospect-scene:main_front_exterior"] },
      { id: "alternate", url: "https://cdn.test/alternate.jpg", tags: ["prospect-scene:alternate_exterior"] },
      { id: "living", url: "https://cdn.test/living.jpg", tags: ["prospect-scene:living_interior"] },
      { id: "yard", url: "https://cdn.test/yard.jpg", tags: ["prospect-scene:yard_land"] },
    ];
    const drafts = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"].map((channel, index) => ({ id: `draft-${index}`, channel, body: "Now available." }));
    const allocations = allocateProspectPreviewMedia(drafts, () => ({ propertyAssets: assets }));
    expect(allocations.map(({ assets: selected }) => selected[0].id)).toEqual(["front", "alternate", "yard"]);
    expect(new Set(allocations.map(({ assets: selected }) => selected[0].id)).size).toBe(3);
    expect(allocations.every(({ assets: selected }) => new Set(selected.map(propertyAssetIdentity)).size === selected.length)).toBe(true);
  });

  it("does not repeat the same three-image gallery across posts", () => {
    const scenes = ["main_front_exterior", "alternate_exterior", "yard_land", "kitchen", "living_interior", "bedroom"];
    const assets = scenes.map((scene, index) => ({ id: `image-${index}`, url: `https://cdn.test/listing/image-${index}.jpg`, tags: [`prospect-scene:${scene}`] }));
    const drafts = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"].map((channel, index) => ({ id: `draft-${index}`, channel, body: "Now available." }));
    const allocations = allocateProspectPreviewMedia(drafts, () => ({ propertyAssets: assets }));
    const instagram = allocations[0].assets.map(propertyAssetIdentity);
    const facebook = allocations[1].assets.map(propertyAssetIdentity);
    expect(instagram).toHaveLength(3);
    expect(facebook).toHaveLength(3);
    expect(new Set(instagram)).not.toEqual(new Set(facebook));
    expect(new Set([...instagram, ...facebook]).size).toBeGreaterThan(3);
  });

  it("allows controlled reuse when a listing has only one logical image", () => {
    const assets = [{ id: "only", url: "https://cdn.test/only.jpg", tags: ["prospect-scene:main_front_exterior"] }];
    const drafts = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"].map((channel, index) => ({ id: `draft-${index}`, channel, body: "Now available." }));
    const allocations = allocateProspectPreviewMedia(drafts, () => ({ propertyAssets: assets }));
    expect(allocations.map(({ assets: selected }) => selected[0].id)).toEqual(["only", "only", "only"]);
    expect(allocations.slice(1).every(({ reuseUnavoidable }) => reuseUnavoidable)).toBe(true);
  });

  it("keeps every post on its own listing and prefers a requested feature", () => {
    const listingA = [{ id: "a-front", url: "https://cdn.test/a-front.jpg", tags: ["prospect-scene:main_front_exterior"] }, { id: "a-kitchen", url: "https://cdn.test/a-kitchen.jpg", tags: ["prospect-scene:kitchen"] }];
    const listingB = [{ id: "b-front", url: "https://cdn.test/b-front.jpg", tags: ["prospect-scene:main_front_exterior"] }];
    const drafts = [{ id: "a", channel: "INSTAGRAM", body: "See the updated kitchen." }, { id: "b", channel: "FACEBOOK", body: "Now available." }];
    const allocations = allocateProspectPreviewMedia(drafts, (draft) => ({ propertyAssets: draft.id === "a" ? listingA : listingB }));
    expect(allocations[0].assets[0].id).toBe("a-kitchen");
    expect(allocations[1].assets[0].id).toBe("b-front");
  });

  it("accepts a valid partial Coldwell extraction when its title supplies the complete address", () => {
    const listing = { title: "6049 Big Run Road, Pleasant Twp, OH 45121 - MLS# 1888490 - Coldwell Banker", price: 151900, address: { street: null, city: null, state: null, zip: null }, images: ["https://images-listings.coldwellbanker.com/OH_CINCY/1888490_P00.jpg"] };
    expect(isUsableProspectListing(listing, 0.56)).toBe(true);
  });

  it("continues to reject low-evidence or address-incomplete listing pages", () => {
    expect(isUsableProspectListing({ title: "Homes for sale", price: 151900, images: ["https://images-listings.coldwellbanker.com/P00.jpg"] }, 0.56)).toBe(false);
    expect(isUsableProspectListing({ title: "6049 Big Run Road, Pleasant Twp, OH 45121", images: ["https://images-listings.coldwellbanker.com/P00.jpg"] }, 0.56)).toBe(false);
    expect(isUsableProspectListing({ title: "6049 Big Run Road, Pleasant Twp, OH 45121", price: 151900, images: [] }, 0.56)).toBe(false);
  });
});
