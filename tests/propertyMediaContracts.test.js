import { describe, expect, it } from "vitest";
import { isSystemMediaTag, propertyImageSourceKey, scenePresentation, visibleMediaTags } from "../domains/studio/propertyMedia.service.js";

describe("canonical property media contracts", () => {
  it("deduplicates listing size and query variants", () => {
    expect(propertyImageSourceKey("https://cdn.example.com/listing_P001_large.jpg?w=1200")).toBe(propertyImageSourceKey("https://cdn.example.com/listing_P001_thumb.jpg?fit=crop"));
  });
  it("keeps workflow metadata out of visible smart tags", () => {
    const tags = ["kitchen", "property", "property:item-1", "prospect-scene:kitchen", "prospect-clear-view"];
    expect(visibleMediaTags(tags)).toEqual(["kitchen"]);
    expect(tags.filter(isSystemMediaTag)).toHaveLength(4);
  });
  it.each([
    ["aerial", "aerial", "Aerial View"], ["main_front_exterior", "front exterior", "Front Exterior"], ["floorplan", "floorplan", "Floor Plan"],
    ["kitchen", "kitchen", "Kitchen"], ["living_interior", "living room", "Living Room"], ["other_interior", "interior", "Other Interior"],
  ])("maps %s to a stable semantic tag and title", (scene, tag, title) => {
    expect(scenePresentation(scene)).toEqual({ tags: [tag], title });
  });
});
