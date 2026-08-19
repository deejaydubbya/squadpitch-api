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
    expect(provider.discoverDirectoryPages("https://www.coldwellbankerhomes.com/oh/columbus/agents/", directory)).toEqual(["https://www.coldwellbankerhomes.com/oh/columbus/agents/p_2"]);
  });

  it("selects one sequential forward page from partial pagination controls", () => {
    const partial = `<a href="/oh/columbus/agents/">1</a><a href="/oh/columbus/agents/p_2/">2</a><a href="/oh/columbus/agents/p_3/">3</a><a href="/oh/columbus/agents/p_45/">45</a>`;
    expect(provider.discoverDirectoryPages("https://www.coldwellbankerhomes.com/oh/columbus/agents/", partial)).toEqual(["https://www.coldwellbankerhomes.com/oh/columbus/agents/p_2"]);
    const gap = `<a href="/oh/columbus/agents/">1</a><a href="/oh/columbus/agents/p_7/">7</a><a href="/oh/columbus/agents/p_8/">8</a><a href="/oh/columbus/agents/p_9/">9</a><a href="/oh/columbus/agents/p_10/">10</a><a href="/oh/columbus/agents/p_45/">45</a>`;
    expect(provider.discoverDirectoryPages("https://www.coldwellbankerhomes.com/oh/columbus/agents/p_8/", gap)).toEqual(["https://www.coldwellbankerhomes.com/oh/columbus/agents/p_9"]);
  });

  it("does not leave the starting directory or follow backward pagination", () => {
    const html = `<a rel="next" href="/oh/cincinnati/agents/p_4/">Other city</a><a rel="next" href="/oh/columbus/agents/p_2/">Previous</a>`;
    expect(provider.discoverDirectoryPages("https://www.coldwellbankerhomes.com/oh/columbus/agents/p_3/", html)).toEqual([]);
  });

  it("parses profile contact data and discovers the same-agent listings link", () => {
    const profile = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/", `
      <script type="application/ld+json">{"@type":"Person","name":"Test Agent","email":"Test.Agent@example.com","telephone":"555-0100","worksFor":{"name":"Coldwell Banker Realty"},"image":"https://img.example/test.jpg"}</script>
      <a href="/oh/columbus/agent/test-agent/aid_101/listings/">My Listings</a>`);
    expect(profile).toMatchObject({ fullName: "Test Agent", firstName: "Test", lastName: "Agent", email: "Test.Agent@example.com", providerExternalId: "101", listingsUrl: "https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/listings/" });
    const withoutEmail = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/columbus/agent/no-email/aid_102/", "<h1>No Email</h1>");
    expect(withoutEmail.email).toBeNull();
  });

  it("selects a reliable agent headshot and rejects logos and listing photos", () => {
    const structured = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/agent/jane/aid_101/", `<script type="application/ld+json">{"@type":"Person","name":"Jane Agent","image":"https://cdn.example/jane-headshot.jpg"}</script><header><img src="/logo.png" alt="Brokerage logo"></header>`);
    expect(structured.headshotUrl).toBe("https://cdn.example/jane-headshot.jpg");
    const header = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/agent/jane/aid_101/", `<h1>Jane Agent</h1><header class="agent-profile"><img src="https://cdn.example/jane.jpg" alt="Jane Agent"></header><article class="listing"><img src="https://cdn.example/property.jpg"></article>`);
    expect(header.headshotUrl).toBe("https://cdn.example/jane.jpg");
    const unreliable = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/agent/jane/aid_101/", `<h1>Jane Agent</h1><header><img src="/brokerage-logo.png"></header><article class="listing"><img src="/property-photo.jpg"></article><meta property="og:image" content="https://cdn.example/site-brand.png">`);
    expect(unreliable.headshotUrl).toBeNull();
  });

  it("selects the same-agent listing collection instead of unrelated View All links", () => {
    const profile = provider.parseProfile("https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/", `
      <a href="/photos/">View All Photos</a><a href="/tax/">View All Tax History</a>
      <section class="current-listings"><a href="/oh/columbus/agent/test-agent/aid_101/listings/">View All Listings</a></section>`);
    expect(profile.listingsUrl).toBe("https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/listings/");
  });

  it("returns true active listing counts and excludes sold, closed, and duplicate cards", () => {
    const card = (id, status = "Active") => `<article>${status} <a href="/oh/columbus/${id}-main/pid_${id}/">${id} Main St $500,000 3 beds 2 baths 1,500 sqft</a></article>`;
    expect(provider.parseListings("https://www.coldwellbankerhomes.com/agent/listings/", "")).toHaveLength(0);
    expect(provider.parseListings("https://www.coldwellbankerhomes.com/agent/listings/", card(1))).toHaveLength(1);
    expect(provider.parseListings("https://www.coldwellbankerhomes.com/agent/listings/", [1,2,3,4,5].map((id) => card(id)).join(""))).toHaveLength(5);
    const mixed = `${card(1)}${card(2)}${card(3)}${card(4,"Sold")}${card(5,"Closed")}${card(1)}`;
    const active = provider.parseListings("https://www.coldwellbankerhomes.com/agent/listings/", mixed);
    expect(active).toHaveLength(3);
    expect(active[0]).toMatchObject({ listingId: "1", beds: 3, baths: 2, squareFeet: 1500, status: "ACTIVE" });
  });

  it("follows only the next page of the same agent listing collection", () => {
    const encoded = encodeURIComponent(encodeURIComponent("/oh/columbus/agent/test-agent/aid_101/listings/"));
    const html = `<a href="/oh/columbus/kvc-1_101/p_5/?originalURL=${encoded}">5</a><a rel="next" href="/oh/columbus/kvc-1_101/p_2/?originalURL=${encoded}">Next</a><a rel="next" href="/oh/columbus/kvc-2_999/p_2/?originalURL=%252foh%252fagent%252fother%252faid_999%252flistings%252f">Other</a>`;
    expect(provider.discoverListingPages("https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101/listings/", html, "https://www.coldwellbankerhomes.com/oh/columbus/agent/test-agent/aid_101")).toEqual([expect.stringContaining("/kvc-1_101/p_2/")]);
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
