import { describe, expect, it } from "vitest";
import { coldwellBankerHomesProvider as provider } from "../domains/prospects/discovery/coldwellBankerHomes.provider.js";

const directory = `
  <a href="/oh/columbus/agent/agent-a/aid_101/">Agent A</a>
  <a href="/oh/columbus/agent/agent-b/aid_102/?utm_source=x">Agent B</a>
  <a href="/oh/columbus/agent/agent-a/aid_101/">Agent A duplicate</a>
  <a rel="next" href="/oh/columbus/agents/p_2/">Next</a>`;

describe("Coldwell Banker Homes discovery provider", () => {
  it("recognizes directory/profile/listings pages and stable identities", () => {
    expect(provider.supports("https://www.coldwellbankerhomes.com/oh/columbus/agents/")).toBe(true);
    expect(provider.classify("https://www.coldwellbankerhomes.com/oh/columbus/agents/", directory)).toBe("AGENT_DIRECTORY");
    expect(provider.classify("https://www.coldwellbankerhomes.com/oh/columbus/agent/a/aid_101/", "")).toBe("AGENT_PROFILE");
    expect(provider.classify("https://www.coldwellbankerhomes.com/oh/columbus/agent/a/aid_101/listings/", "")).toBe("AGENT_LISTINGS");
    expect(provider.identity("https://www.coldwellbankerhomes.com/OH/Columbus/agent/A/aid_101/?utm=x#top")).toEqual({ provider: "COLDWELL_BANKER_HOMES", providerExternalId: "101", normalizedProfileUrl: "https://www.coldwellbankerhomes.com/oh/columbus/agent/a/aid_101" });
  });

  it("discovers pagination and de-duplicates repeated agents on a directory page", () => {
    const links = provider.discoverAgentLinks("https://www.coldwellbankerhomes.com/oh/columbus/agents/", directory);
    expect(links.map((link) => link.providerExternalId)).toEqual(["101", "102"]);
    expect(provider.discoverDirectoryPages("https://www.coldwellbankerhomes.com/oh/columbus/agents/", directory)).toEqual(["https://www.coldwellbankerhomes.com/oh/columbus/agents/p_2/"]);
  });

  it("parses profile contact data and discovers the same-agent listings link", () => {
    const profile = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/", `
      <script type="application/ld+json">{"@type":"Person","name":"Test Agent","email":"Test.Agent@example.com","telephone":"555-0100","worksFor":{"name":"Coldwell Banker Realty"},"image":"https://img.example/test.jpg"}</script>
      <a href="/oh/columbus/agent/test-agent/aid_101/listings/">My Listings</a>`);
    expect(profile).toMatchObject({ fullName: "Test Agent", firstName: "Test", lastName: "Agent", email: "Test.Agent@example.com", providerExternalId: "101", listingsUrl: "https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/listings/" });
    const withoutEmail = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/columbus/agent/no-email/aid_102/", "<h1>No Email</h1>");
    expect(withoutEmail.email).toBeNull();
  });

  it("keeps active listings and conservatively excludes sold/pending listings", () => {
    const listings = provider.parseListings("https://www.coldwellbankerhomes.com/oh/columbus/agent/test/aid_101/listings/", `
      <article><a href="/oh/columbus/home/123-main/pid_1/">123 Main St $450,000</a></article>
      <article>Sold <a href="/oh/columbus/home/456-old/pid_2/">456 Old St</a></article>
      <article>Pending <a href="/oh/columbus/home/789-wait/pid_3/">789 Wait St</a></article>`);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ address: "123 Main St $450,000", price: "$450,000", status: "ACTIVE" });
    expect(provider.parseListings("https://www.coldwellbankerhomes.com/a/listings/", "<p>No active listings.</p>")).toEqual([]);
  });
});
