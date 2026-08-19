import { describe, expect, it } from "vitest";
import { extractListingFromScrapedData } from "../domains/studio/listingIngestion.service.js";

describe("listing address normalization", () => {
  it.each([
    ["130 E Walnut St, Westerville, OH 43082 - Coldwell Banker", "130 E Walnut St", "Westerville", "43082"],
    ["183 Rugg Ave, Newark, OH 43055 - MLS 226030536 - Coldwell Banker", "183 Rugg Ave", "Newark", "43055"],
    ["12960 Appleton Rd, Johnstown, OH 43031 - Coldwell Banker", "12960 Appleton Rd", "Johnstown", "43031"],
    ["42 W 3rd St, Columbus, OH 43215 - Coldwell Banker", "42 W 3rd St", "Columbus", "43215"],
  ])("prefers delimited title components for %s", (title, street, city, zip) => {
    const listing = extractListingFromScrapedData({ title, text: `${zip}${street} $300,000`, images: [] }, "https://www.coldwellbankerhomes.com/listing");
    expect(listing.address).toEqual({ street, city, state: "OH", zip });
    expect(listing.address.street).not.toContain(zip);
  });

  it("does not accept a ZIP-glued house number from flattened body text", () => {
    const listing = extractListingFromScrapedData({ title: "Property for sale", text: "43055183 Rugg Ave $300,000", images: [] }, "https://www.coldwellbankerhomes.com/oh/newark/183-rugg-ave/pid_73026102/");
    expect(listing.address.street).toBeNull();
  });
});
