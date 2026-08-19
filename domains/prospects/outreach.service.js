import crypto from "node:crypto";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";
import { prisma } from "../../prisma.js";
import { env } from "../../config/env.js";
import { assertSafeExternalUrl } from "../studio/urlCampaignIntake.service.js";
import { encryptToken, decryptToken } from "../../lib/tokenCrypto.js";
import { createProspect, digestSecret, startProspectPreparation } from "./prospect.service.js";
import { getDiscoveryProvider } from "./discovery/providers.js";
import { normalizePublicUrl } from "./discovery/urlIdentity.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SUBJECT = "I created a free Squadpitch workspace for you";
const DEFAULT_BODY = `Hi {{first_name}},

I’m Daniel, the founder of Squadpitch. I’m reaching out to a small group of real estate agents and creating ready-to-claim workspaces for them so they can get started without having to build everything from scratch.

Squadpitch helps real estate agents turn listings, open houses, sold properties, and other business updates into ready-to-post social media content using AI.

I’ve already created a free workspace for you here:

{{preview_url}}

Important: when you create your Squadpitch account, please use the same email address I sent this message to. That’s how Squadpitch recognizes you and connects you with the workspace I created for you.

Once you’re in, you can also start a 14-day trial of Squadpitch Pro with no credit card required to try the full set of Pro features. If you find it useful, you can choose a paid plan afterward.

You can also learn more about Squadpitch here:

Website: https://real-estate.squadpitch.com
LinkedIn: https://www.linkedin.com/company/115992427

I’m working directly with these first users, so I’d really appreciate any feedback you have. If you run into anything confusing or have an idea that would make Squadpitch more useful for agents, just reply to this email.

Thanks,

Daniel Wardlow
Founder, Squadpitch

If you’d rather not receive messages like this from me, you can unsubscribe here:
{{unsubscribe_url}}`;
const DEFAULT_HTML_BODY = `<div style="max-width:600px;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.6;color:#202124;background:#ffffff;">
  <p>Hi {{first_name}},</p>
  <p>I'm Daniel, the founder of Squadpitch. I'm reaching out to a small group of real estate agents and creating ready-to-claim workspaces for them so they can get started without having to build everything from scratch.</p>
  <p>Squadpitch helps real estate agents turn listings, open houses, sold properties, and other business updates into ready-to-post social media content using AI.</p>
  <p>I've already created a free workspace for you here:</p>
  <p><a href="{{preview_url}}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#166534;color:#ffffff;text-decoration:none;font-weight:600;">View &amp; Claim Your Workspace</a></p>
  <p style="font-size:13px;color:#5f6368;">If the button doesn't work, use this link: <a href="{{preview_url}}" style="color:#166534;word-break:break-all;">{{preview_url}}</a></p>
  <p><strong>Important:</strong> when you create your Squadpitch account, <strong>please use the same email address I sent this message to.</strong> That's how Squadpitch recognizes you and connects you with the workspace I created for you.</p>
  <p>Once you're in, you can also start a 14-day trial of Squadpitch Pro with no credit card required to try the full set of Pro features. If you find it useful, you can choose a paid plan afterward.</p>
  <p>You can also learn more about Squadpitch here:</p>
  <p><a href="https://real-estate.squadpitch.com" style="color:#166534;">Squadpitch website</a><br><a href="https://www.linkedin.com/company/115992427" style="color:#166534;">Squadpitch on LinkedIn</a></p>
  <p>I'm working directly with these first users, so I'd really appreciate any feedback you have. If you run into anything confusing or have an idea that would make Squadpitch more useful for agents, just reply to this email.</p>
  <p>Thanks,</p>
  <p>Daniel Wardlow<br>Founder, Squadpitch</p>
  <p style="margin-top:28px;font-size:12px;line-height:1.5;color:#5f6368;">If you'd rather not receive messages like this from me, you can unsubscribe <a href="{{unsubscribe_url}}" style="color:#5f6368;">here</a>.</p>
</div>`;

const ALLOWED_EMAIL_TAGS = new Set(["div", "p", "br", "a", "strong", "b", "em", "i", "span", "table", "tbody", "tr", "td"]);
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function safeEmailUrl(value) { try { const url = new URL(String(value)); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : "#"; } catch { return "#"; } }
export function sanitizeEmailHtml(html) {
  const $ = cheerio.load(String(html || ""), null, false);
  $("*").each((_index, node) => {
    const tag = node.tagName?.toLowerCase();
    if (!ALLOWED_EMAIL_TAGS.has(tag)) { $(node).replaceWith($(node).contents()); return; }
    for (const attribute of Object.keys(node.attribs || {})) if (!["href", "style"].includes(attribute.toLowerCase())) $(node).removeAttr(attribute);
    if (tag === "a") $(node).attr("href", safeEmailUrl($(node).attr("href")));
    if ($(node).attr("style")) {
      const style = $(node).attr("style").replace(/url\s*\([^)]*\)|expression\s*\([^)]*\)|@import|javascript:/gi, "");
      $(node).attr("style", style);
    }
  });
  return $.html();
}

async function canonicalTemplate() {
  return prisma.outreachEmailTemplate.upsert({ where: { id: "default" }, create: { id: "default", subject: DEFAULT_SUBJECT, textBody: DEFAULT_BODY, htmlBody: DEFAULT_HTML_BODY }, update: {} });
}

export async function updateOutreachTemplate(input) {
  // Keep placeholders intact in storage. Every rendered delivery is sanitized
  // after escaped dynamic values have been substituted.
  return prisma.outreachEmailTemplate.upsert({ where: { id: "default" }, create: { id: "default", subject: input.subject, textBody: input.textBody, htmlBody: input.htmlBody }, update: { subject: input.subject, textBody: input.textBody, htmlBody: input.htmlBody } });
}

function normalizedEmail(value) { return String(value || "").trim().toLowerCase(); }
function text(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function absolute(value, base) { try { return new URL(value, base).toString(); } catch { return null; } }
function publicAppOrigin() {
  try {
    const url = new URL(env.APP_URL);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    throw Object.assign(new Error("APP_URL must be configured as the public Squadpitch web origin"), { status: 503, code: "OUTREACH_APP_URL_NOT_CONFIGURED" });
  }
}

export function parseDiscoveryPage(html, sourceUrl) {
  const url = sourceUrl instanceof URL ? sourceUrl : new URL(sourceUrl);
  const $ = cheerio.load(html);
  const listings = $("a[href]").map((_i, el) => {
    const href = absolute($(el).attr("href"), url);
    const label = text($(el).text());
    return href && /listing|property|home|for-sale|mls/i.test(`${href} ${label}`) && !/sold|pending|closed/i.test(label) ? { listingUrl: href, address: label || null, status: "ACTIVE", sourceUrl: href } : null;
  }).get().filter(Boolean).slice(0, 25);
  const people = [];
  $("script[type='application/ld+json']").each((_i, node) => {
    try {
      const raw = JSON.parse($(node).text());
      const values = Array.isArray(raw) ? raw : raw?.["@graph"] || [raw];
      for (const item of values) if (item?.["@type"] === "Person" || item?.["@type"]?.includes?.("Person")) people.push(item);
    } catch {}
  });
  if (!people.length) {
    const emails = [...new Set($("a[href^='mailto:']").map((_i, el) => normalizedEmail($(el).attr("href").slice(7).split("?")[0])).get())];
    for (const email of emails) people.push({ name: text($("h1").first().text()) || email.split("@")[0], email, url: url.toString() });
  }
  return { people, listings };
}

export function qualifyDiscoveredAgent(person, listings) {
  const email = normalizedEmail(person.email || person.contactPoint?.email);
  if (!email) return { email: null, status: "NO_EMAIL", rejectionReason: "NO_EMAIL" };
  if (!EMAIL_RE.test(email)) return { email, status: "INVALID_EMAIL", rejectionReason: "INVALID_EMAIL" };
  if (!listings.length) return { email, status: "NO_ACTIVE_LISTINGS", rejectionReason: "NO_ACTIVE_LISTINGS" };
  return { email, status: "QUALIFIED", rejectionReason: null };
}

function listingIdentity(listing) {
  if (listing?.listingId) return `id:${String(listing.listingId).trim().toLowerCase()}`;
  const url = normalizePublicUrl(listing?.listingUrl || listing?.sourceUrl);
  return url ? `url:${url}` : null;
}

export function selectListingsForPreview(listings, targetCount = 3) {
  const distinct = [];
  const seen = new Set();
  for (const listing of Array.isArray(listings) ? listings : []) {
    const identity = listingIdentity(listing);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    distinct.push(listing);
    if (distinct.length === targetCount) break;
  }
  if (!distinct.length) return [];
  return Array.from({ length: targetCount }, (_value, index) => distinct[index % distinct.length]);
}

async function fetchDiscoveryPage(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "SquadpitchAgentDiscovery/1.0 (+ordinary-admin-request)" } });
  if (!response.ok) throw Object.assign(new Error(`Source returned HTTP ${response.status}`), { code: "UNSUPPORTED_PAGE" });
  return response.text();
}

async function existingTarget({ provider, providerExternalId, normalizedProfileUrl, email }) {
  const identities = [
    ...(email ? [{ normalizedEmail: normalizedEmail(email) }] : []),
    ...(provider && providerExternalId ? [{ provider_providerExternalId: { provider, providerExternalId } }] : []),
    ...(normalizedProfileUrl ? [{ stableIdentity: normalizedProfileUrl }] : []),
  ];
  for (const identity of identities) {
    const row = await prisma.agentOutreachProspect.findUnique({ where: identity, select: { id: true, status: true } });
    if (row) return row;
  }
  if (provider === "COLDWELL_BANKER_HOMES" && providerExternalId) {
    const legacy = await prisma.agentOutreachProspect.findFirst({ where: { OR: [{ profileUrl: { contains: `aid_${providerExternalId}`, mode: "insensitive" } }, { stableIdentity: { contains: `aid_${providerExternalId}`, mode: "insensitive" } }] }, select: { id: true, status: true } });
    if (legacy) return legacy;
  }
  return null;
}

export async function analyzeDiscoverySource(sourceUrl) {
  const url = assertSafeExternalUrl(sourceUrl);
  const provider = getDiscoveryProvider(url);
  if (!provider) return { provider: null, pageType: "UNSUPPORTED", agentLinksFound: 0, alreadyTargeted: 0, potentiallyNew: 0, paginationDetected: false, ready: false, samples: [] };
  const html = await fetchDiscoveryPage(url);
  const pageType = provider.classify(url, html);
  const links = provider.discoverAgentLinks(url, html);
  let alreadyTargeted = 0;
  for (const link of links) if (await existingTarget(link)) alreadyTargeted += 1;
  return { provider: { key: provider.key, label: provider.label }, pageType, agentLinksFound: links.length, alreadyTargeted, potentiallyNew: links.length - alreadyTargeted, paginationDetected: provider.discoverDirectoryPages(url, html).length > 0, ready: pageType === "AGENT_DIRECTORY" && links.length > 0, samples: links.slice(0, 5).map(({ label, profileUrl, providerExternalId }) => ({ name: label, profileUrl, providerExternalId })) };
}

async function discoveryStatus(runId) {
  return prisma.agentDiscoveryRun.findUnique({ where: { id: runId }, select: { status: true } });
}

async function executeDiscoveryRun(run, provider, url, options = {}) {
  const resume = run.cursor && typeof run.cursor === "object" ? run.cursor : {};
  const maxPages = options.maxPages ?? resume.maxPages ?? null, maxAgents = options.maxAgents ?? resume.maxAgents ?? null, delayMs = Math.max(Number(options.delayMs ?? 250), 0);
  const pageQueue = [resume.nextPage || url.toString()].filter(Boolean), visitedPages = new Set(resume.visitedPages || []), visitedAgents = new Set(resume.visitedAgents || []);
  let pagesScanned = run.pagesScanned || 0, agentLinksFound = run.agentLinksFound || 0, profilesFound = run.profilesFound || 0, newAgents = run.newAgentsCount || 0, qualified = run.qualifiedCount || 0, rejected = run.rejectedCount || 0, duplicates = run.duplicateCount || 0, suppressedCount = run.suppressedCount || 0, errors = run.errorCount || 0;
  const saveProgress = (nextPage = null) => prisma.agentDiscoveryRun.update({ where: { id: run.id }, data: { pagesScanned, agentLinksFound, profilesFound, newAgentsCount: newAgents, qualifiedCount: qualified, rejectedCount: rejected, duplicateCount: duplicates, suppressedCount, errorCount: errors, cursor: { nextPage, currentPage: pagesScanned + 1, visitedPages: [...visitedPages], visitedAgents: [...visitedAgents], maxPages, maxAgents } } });
  while (pageQueue.length && (maxPages == null || pagesScanned < maxPages) && (maxAgents == null || newAgents < maxAgents)) {
    if ((await discoveryStatus(run.id))?.status !== "RUNNING") return saveProgress(pageQueue[0]);
    const pageUrl = pageQueue.shift(), pageKey = normalizePublicUrl(pageUrl) || new URL(pageUrl).toString();
    if (visitedPages.has(pageKey)) continue;
    visitedPages.add(pageKey);
    let html;
    try { html = await fetchDiscoveryPage(pageUrl); pagesScanned += 1; } catch { errors += 1; await saveProgress(); continue; }
    const [nextPage] = provider.discoverDirectoryPages(pageUrl, html);
    const links = provider.discoverAgentLinks(pageUrl, html);
    agentLinksFound += links.length;
    for (const link of links) {
      if (maxAgents != null && newAgents >= maxAgents) break;
      if ((await discoveryStatus(run.id))?.status !== "RUNNING") { visitedPages.delete(pageKey); return saveProgress(pageUrl); }
      const identityKey = `${link.provider}:${link.providerExternalId || link.normalizedProfileUrl}`;
      if (visitedAgents.has(identityKey)) continue;
      visitedAgents.add(identityKey);
      if (await existingTarget(link)) { duplicates += 1; continue; }
      try {
        if ((await discoveryStatus(run.id))?.status !== "RUNNING") { visitedPages.delete(pageKey); return saveProgress(pageUrl); }
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const profileHtml = await fetchDiscoveryPage(link.profileUrl);
        profilesFound += 1;
        if ((await discoveryStatus(run.id))?.status !== "RUNNING") { visitedPages.delete(pageKey); return saveProgress(pageUrl); }
        const agent = provider.parseProfile(link.profileUrl, profileHtml);
        if (await existingTarget({ ...link, email: agent.email })) { duplicates += 1; continue; }
        const email = normalizedEmail(agent.email) || null;
        const suppressed = email ? await prisma.outreachSuppression.findFirst({ where: { normalizedEmail: email, restoredAt: null } }) : null;
        let listings = [];
        const preQualification = qualifyDiscoveredAgent(agent, [{}]);
        if (!suppressed && preQualification.status === "QUALIFIED" && agent.listingsUrl) {
          let listingPage = agent.listingsUrl;
          const visitedListingPages = new Set(), listingKeys = new Set();
          while (listingPage && !visitedListingPages.has(normalizePublicUrl(listingPage) || listingPage)) {
            if ((await discoveryStatus(run.id))?.status !== "RUNNING") { visitedPages.delete(pageKey); return saveProgress(pageUrl); }
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            visitedListingPages.add(normalizePublicUrl(listingPage) || listingPage);
            const listingHtml = await fetchDiscoveryPage(listingPage);
            for (const listing of provider.parseListings(listingPage, listingHtml)) { const key = listing.listingId || listing.listingUrl; if (key && !listingKeys.has(key)) { listingKeys.add(key); listings.push(listing); } }
            listingPage = provider.discoverListingPages?.(listingPage, listingHtml, agent.profileUrl)?.[0] || null;
          }
        }
        let qualification = qualifyDiscoveredAgent(agent, listings);
        if (suppressed) qualification = { email, status: "SUPPRESSED", rejectionReason: "SUPPRESSED" };
        const prospect = await prisma.agentOutreachProspect.create({ data: { discoveryRunId: run.id, normalizedEmail: qualification.email, email: qualification.email, firstName: agent.firstName, lastName: agent.lastName, fullName: agent.fullName, phone: agent.phone, brokerage: agent.brokerage, office: agent.office, profileUrl: agent.profileUrl, headshotUrl: agent.headshotUrl, sourceUrl: url.toString(), sourceDomain: url.hostname.toLowerCase(), provider: agent.provider, providerExternalId: agent.providerExternalId, stableIdentity: agent.normalizedProfileUrl, status: qualification.status, rejectionReason: qualification.rejectionReason, listings, activeListingCount: listings.length, lastVerifiedAt: new Date(), events: { create: { type: qualification.status === "QUALIFIED" ? "qualified" : "rejected", message: qualification.rejectionReason } } } });
        newAgents += 1;
        if (prospect.status === "QUALIFIED") qualified += 1; else { rejected += 1; if (prospect.status === "SUPPRESSED") suppressedCount += 1; }
      } catch (error) { if (error?.code === "P2002") duplicates += 1; else errors += 1; }
    }
    if ((await discoveryStatus(run.id))?.status !== "RUNNING") return saveProgress(nextPage || null);
    if (nextPage && !visitedPages.has(normalizePublicUrl(nextPage))) pageQueue.push(nextPage);
    await saveProgress(pageQueue[0] || null);
  }
  const foundAny = agentLinksFound > 0;
  return prisma.agentDiscoveryRun.update({ where: { id: run.id }, data: { status: foundAny ? "COMPLETED" : "FAILED", pagesScanned, agentLinksFound, profilesFound, newAgentsCount: newAgents, qualifiedCount: qualified, rejectedCount: rejected, duplicateCount: duplicates, suppressedCount, errorCount: errors, cursor: { nextPage: null, currentPage: pagesScanned, visitedPages: [...visitedPages], visitedAgents: [...visitedAgents], maxPages, maxAgents }, completedAt: new Date(), ...(!foundAny ? { lastError: "No supported agent profile links were found" } : {}) } });
}

export async function discoverAgents(sourceUrl, adminSub, options = {}) {
  const url = assertSafeExternalUrl(sourceUrl);
  const provider = getDiscoveryProvider(url);
  const run = await prisma.agentDiscoveryRun.create({ data: { sourceUrl: url.toString(), sourceDomain: url.hostname.toLowerCase(), requestedBy: adminSub } });
  try {
    if (!provider) throw Object.assign(new Error("No agent discovery provider supports this URL"), { code: "UNSUPPORTED_PAGE" });
    const limits = { ...options, maxPages: options.maxPages == null ? null : Math.min(Number(options.maxPages), 1000), maxAgents: options.maxAgents == null ? null : Math.min(Number(options.maxAgents), 10_000) };
    if (options.background) { void executeDiscoveryRun(run, provider, url, limits).catch(async (error) => { await prisma.agentDiscoveryRun.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { status: "FAILED", lastError: error.message, completedAt: new Date() } }); }); return run; }
    return executeDiscoveryRun(run, provider, url, limits);
  } catch (error) {
    return prisma.agentDiscoveryRun.update({ where: { id: run.id }, data: { status: "FAILED", pagesScanned: 1, errorCount: 1, lastError: error.message, completedAt: new Date() } });
  }
}

export async function pauseDiscovery(id) {
  await prisma.agentDiscoveryRun.updateMany({ where: { id, status: "RUNNING" }, data: { status: "PAUSED" } });
  return prisma.agentDiscoveryRun.findUnique({ where: { id } });
}
export async function stopDiscovery(id) {
  await prisma.agentDiscoveryRun.updateMany({ where: { id, status: { in: ["RUNNING", "PAUSED"] } }, data: { status: "STOPPED", completedAt: new Date() } });
  return prisma.agentDiscoveryRun.findUnique({ where: { id } });
}
export async function resumeDiscovery(id, options = {}) {
  const run = await prisma.agentDiscoveryRun.findUnique({ where: { id } });
  if (!run || run.status !== "PAUSED") throw Object.assign(new Error("Only a paused discovery can be resumed"), { status: 409, code: "INVALID_DISCOVERY_STATE" });
  const url = assertSafeExternalUrl(run.sourceUrl), provider = getDiscoveryProvider(url);
  const resumed = await prisma.agentDiscoveryRun.update({ where: { id }, data: { status: "RUNNING", completedAt: null } });
  if (options.background) { void executeDiscoveryRun(resumed, provider, url, options).catch(async (error) => { await prisma.agentDiscoveryRun.updateMany({ where: { id, status: "RUNNING" }, data: { status: "FAILED", lastError: error.message, completedAt: new Date() } }); }); return resumed; }
  return executeDiscoveryRun(resumed, provider, url, options);
}

export async function listPipeline() {
  await syncClaimed();
  const [prospects, runs, accounts, template] = await Promise.all([
    prisma.agentOutreachProspect.findMany({ include: { events: { orderBy: { createdAt: "desc" }, take: 20 }, prospectWorkspace: { select: { claimStatus: true, claimedAt: true } }, sendingAccount: { select: { id: true, displayName: true, fromEmail: true, provider: true } } }, orderBy: { discoveredAt: "desc" } }),
    prisma.agentDiscoveryRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    listSendingAccounts(),
    canonicalTemplate(),
  ]);
  return { prospects: prospects.map(publicProspect), runs, accounts, template };
}

function publicProspect(row) {
  let previewUrl = null, claimUrl = null;
  try { previewUrl = row.previewUrlEncrypted ? decryptToken(row.previewUrlEncrypted) : null; claimUrl = row.claimUrlEncrypted ? decryptToken(row.claimUrlEncrypted) : null; } catch {}
  const { previewUrlEncrypted, claimUrlEncrypted, unsubscribeTokenHash, ...safe } = row;
  const manualOutreach = row.status === "MANUAL_OUTREACH";
  const status = manualOutreach ? (row.prospectWorkspace?.claimStatus === "CLAIMED" ? "CLAIMED" : "UNCLAIMED") : row.status;
  return { ...safe, status, outreachType: manualOutreach ? "MANUAL" : "AUTOMATED", previewUrl, claimUrl };
}

export async function generatePreview(id, adminSub) {
  const outreach = await prisma.agentOutreachProspect.findUnique({ where: { id } });
  if (!outreach || !["QUALIFIED", "PREVIEW_PENDING", "PREVIEW_FAILED", "READY_TO_EMAIL", "EMAIL_FAILED"].includes(outreach.status)) throw Object.assign(new Error("Prospect is not eligible for preview generation"), { status: 409, code: "INVALID_OUTREACH_STATE" });
  const selectedListings = selectListingsForPreview(outreach.listings);
  if (!selectedListings.length) throw Object.assign(new Error("Prospect no longer has an active listing"), { status: 422, code: "NO_ACTIVE_LISTINGS" });
  const sourceUrl = selectedListings[0].listingUrl || selectedListings[0].sourceUrl;
  let workspaceId = outreach.prospectWorkspaceId;
  if (!workspaceId) {
    const issued = await createProspect({ prospectName: outreach.fullName, prospectEmail: outreach.email, businessName: outreach.brokerage || `${outreach.fullName} Real Estate`, industryKey: "real_estate", websiteUrl: outreach.profileUrl, profileImageUrl: outreach.headshotUrl, sourceUrl, selectedChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"], acquisitionSource: `Agent discovery: ${outreach.sourceDomain}` }, adminSub);
    workspaceId = issued.id;
    const origin = publicAppOrigin();
    const previewUrl = `${origin}/preview/${issued.previewToken}`;
    const claimUrl = `${previewUrl}#claim=${issued.claimToken}`;
    await prisma.agentOutreachProspect.update({ where: { id }, data: { prospectWorkspaceId: workspaceId, status: "PREVIEW_GENERATING", previewUrlEncrypted: encryptToken(previewUrl), claimUrlEncrypted: encryptToken(claimUrl), events: { create: { type: "preview_queued" } } } });
  } else {
    await prisma.agentOutreachProspect.update({ where: { id }, data: { status: "PREVIEW_GENERATING", lastError: null, events: { create: { type: "preview_requeued" } } } });
  }
  await startProspectPreparation(workspaceId, { sourceUrl, selectedListings, selectedChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"] }, adminSub);
  return { id, status: "PREVIEW_GENERATING" };
}

function render(template, values) { return template.replace(/{{\s*([a-z_]+)\s*}}/g, (_m, key) => values[key] ?? ""); }
export function renderMultipartTemplate(template, values) {
  const safeValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ["preview_url", "unsubscribe_url"].includes(key) ? escapeHtml(safeEmailUrl(value)) : escapeHtml(value)]));
  return { subject: render(template.subject, values), textBody: render(template.textBody, values), htmlBody: sanitizeEmailHtml(render(template.htmlBody, safeValues)) };
}
export async function prepareEmail(id, input = {}) {
  const row = await prisma.agentOutreachProspect.findUnique({ where: { id }, include: { sendingAccount: true, prospectWorkspace: { select: { claimStatus: true } } } });
  if (!row?.claimUrlEncrypted || row.prospectWorkspace?.claimStatus !== "CLAIMABLE" || !["READY_TO_EMAIL", "EMAIL_FAILED"].includes(row.status)) throw Object.assign(new Error("A ready, claimable preview is required"), { status: 409, code: "PREVIEW_REQUIRED" });
  const selectedAccount = input.sendingAccountId ? await prisma.outreachSendingAccount.findUnique({ where: { id: input.sendingAccountId } }) : row.sendingAccount;
  const token = crypto.randomBytes(24).toString("base64url");
  const listing = row.listings?.[0] || {};
  const values = { first_name: row.firstName || row.fullName, agent_name: row.fullName, brokerage: row.brokerage || "", listing_address: listing.address || "", listing_count: String(row.activeListingCount), preview_url: decryptToken(row.claimUrlEncrypted), sender_name: selectedAccount?.displayName || "Squadpitch", unsubscribe_url: `${publicAppOrigin()}/api/public/outreach/unsubscribe?token=${token}` };
  const storedTemplate = await canonicalTemplate();
  const rendered = renderMultipartTemplate({ subject: input.subject || storedTemplate.subject, textBody: input.textBody || input.body || storedTemplate.textBody, htmlBody: input.htmlBody || storedTemplate.htmlBody }, values);
  return publicProspect(await prisma.agentOutreachProspect.update({ where: { id }, data: { emailSubject: rendered.subject, emailBody: rendered.textBody, emailHtmlBody: rendered.htmlBody, unsubscribeTokenHash: digestSecret(token), ...(input.sendingAccountId ? { sendingAccountId: input.sendingAccountId } : {}) }, include: { events: true, sendingAccount: { select: { id: true, displayName: true, fromEmail: true, provider: true } } } }));
}

export async function sendOutreachEmail(id, sendingAccountId) {
  await syncClaimed(id);
  const row = await prisma.agentOutreachProspect.findUnique({ where: { id }, include: { sendingAccount: true, prospectWorkspace: { select: { claimStatus: true } } } });
  const account = sendingAccountId ? await prisma.outreachSendingAccount.findUnique({ where: { id: sendingAccountId } }) : row?.sendingAccount || await prisma.outreachSendingAccount.findFirst({ where: { enabled: true, isDefault: true } });
  if (!row || row.emailSentAt) return row ? publicProspect(row) : null;
  if (row.status === "CLAIMED" || row.prospectWorkspace?.claimStatus === "CLAIMED") throw Object.assign(new Error("Claimed prospects cannot receive outreach"), { status: 409, code: "PROSPECT_CLAIMED" });
  if (row.status === "UNSUBSCRIBED" || !row.email) throw Object.assign(new Error("This prospect is not eligible for email"), { status: 409, code: "EMAIL_NOT_ELIGIBLE" });
  if (!account?.enabled || !row.emailSubject || !row.emailBody || !row.emailHtmlBody || !row.claimUrlEncrypted) throw Object.assign(new Error("Prepare the email and select an enabled sending account"), { status: 409, code: "EMAIL_NOT_READY" });
  if (await prisma.outreachSuppression.findFirst({ where: { normalizedEmail: row.normalizedEmail, restoredAt: null } })) throw Object.assign(new Error("This address is suppressed"), { status: 409, code: "EMAIL_SUPPRESSED" });
  const sinceHour = new Date(Date.now() - 3_600_000), sinceDay = new Date(Date.now() - 86_400_000);
  const [hourly, daily, latest] = await Promise.all([prisma.agentOutreachProspect.count({ where: { sendingAccountId: account.id, emailSentAt: { gte: sinceHour } } }), prisma.agentOutreachProspect.count({ where: { sendingAccountId: account.id, emailSentAt: { gte: sinceDay } } }), prisma.agentOutreachProspect.findFirst({ where: { sendingAccountId: account.id, emailSentAt: { not: null } }, orderBy: { emailSentAt: "desc" }, select: { emailSentAt: true } })]);
  if (hourly >= account.hourlyLimit || daily >= account.dailyLimit) throw Object.assign(new Error("Sending account rate limit reached"), { status: 429, code: "OUTREACH_RATE_LIMIT" });
  if (latest?.emailSentAt && Date.now() - latest.emailSentAt.getTime() < account.delaySeconds * 1000) throw Object.assign(new Error("Sending account delay has not elapsed"), { status: 429, code: "OUTREACH_SEND_DELAY" });
  const locked = await prisma.agentOutreachProspect.updateMany({ where: { id, emailSentAt: null, status: { in: ["READY_TO_EMAIL", "EMAIL_FAILED", "EMAIL_QUEUED"] } }, data: { status: "EMAIL_SENDING", sendingAccountId: account.id } });
  if (locked.count !== 1) throw Object.assign(new Error("This outreach is already sending or no longer eligible"), { status: 409, code: "OUTREACH_SEND_LOCKED" });
  try {
    if (account.provider !== "SMTP") throw Object.assign(new Error("Gmail OAuth is not connected yet"), { code: "GMAIL_NOT_CONNECTED" });
    const transport = nodemailer.createTransport(smtpTransportOptions(account));
    const info = await transport.sendMail({ from: { name: account.displayName, address: account.fromEmail }, replyTo: account.replyTo || undefined, to: row.email, subject: row.emailSubject, text: row.emailBody, html: row.emailHtmlBody });
    return publicProspect(await prisma.agentOutreachProspect.update({ where: { id }, data: { status: "EMAIL_SENT", emailSentAt: new Date(), emailProviderId: info.messageId, lastError: null, events: { create: { type: "email_sent" } } } }));
  } catch (error) {
    await prisma.agentOutreachProspect.update({ where: { id }, data: { status: "EMAIL_FAILED", lastError: error.message, events: { create: { type: "email_failed", message: error.message } } } });
    throw error;
  }
}

export async function listSendingAccounts() { return prisma.outreachSendingAccount.findMany({ select: { id: true, provider: true, displayName: true, fromEmail: true, replyTo: true, smtpHost: true, smtpPort: true, smtpUsername: true, smtpSecure: true, smtpEncryption: true, enabled: true, isDefault: true, hourlyLimit: true, dailyLimit: true, delaySeconds: true, createdAt: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }); }
export async function saveSendingAccount(input, adminSub) {
  if (input.provider === "GMAIL") throw Object.assign(new Error("Gmail OAuth connection is not configured; use SMTP for Google Workspace with an app password"), { status: 501, code: "GMAIL_OAUTH_DEFERRED" });
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) await tx.outreachSendingAccount.updateMany({ data: { isDefault: false } });
    const row = await tx.outreachSendingAccount.create({ data: { provider: input.provider, displayName: input.displayName, fromEmail: normalizedEmail(input.fromEmail), replyTo: input.replyTo || null, smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpUsername: input.smtpUsername, smtpPassword: encryptToken(input.smtpPassword), smtpEncryption: input.smtpEncryption, smtpSecure: input.smtpEncryption === "SSL_TLS", enabled: input.enabled, isDefault: input.isDefault, hourlyLimit: input.hourlyLimit, dailyLimit: input.dailyLimit, delaySeconds: input.delaySeconds, createdByAdminSub: adminSub } });
    return { ...row, smtpPassword: undefined };
  });
}
export async function updateSendingAccount(id, input) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.outreachSendingAccount.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error("Sending account not found"), { status: 404, code: "NOT_FOUND" });
    if (input.isDefault) await tx.outreachSendingAccount.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    const { smtpPassword: replacementPassword, ...changes } = input;
    if (changes.smtpEncryption) changes.smtpSecure = changes.smtpEncryption === "SSL_TLS";
    const row = await tx.outreachSendingAccount.update({ where: { id }, data: { ...changes, smtpPassword: replacementPassword ? encryptToken(replacementPassword) : existing.smtpPassword } });
    const { smtpPassword, ...safe } = row;
    return safe;
  });
}
export async function deleteSendingAccount(id) {
  const inUse = await prisma.agentOutreachProspect.count({ where: { sendingAccountId: id, status: { in: ["EMAIL_QUEUED", "EMAIL_SENDING"] } } });
  if (inUse) throw Object.assign(new Error("Sending account has active outreach"), { status: 409, code: "SENDING_ACCOUNT_IN_USE" });
  await prisma.outreachSendingAccount.delete({ where: { id } });
}
function smtpConfigurationError(error) {
  const response = String(error?.response || error?.message || "");
  if ((error?.code === "EAUTH" || error?.responseCode === 535) && /5\.7\.(139|57)|smtp.*auth.*disabled|authentication.*disabled/i.test(response)) return Object.assign(new Error("Microsoft 365 rejected SMTP authentication for this mailbox or tenant."), { status: 422, code: "SMTP_AUTH_DISABLED" });
  if (error?.code === "EAUTH" || error?.responseCode === 535) return Object.assign(new Error("The SMTP server was reached, but authentication failed. Check credentials and whether SMTP authentication is allowed for this mailbox."), { status: 422, code: "SMTP_AUTH_FAILED" });
  if (error?.code === "ETIMEDOUT") return Object.assign(new Error("Connection to the SMTP server timed out."), { status: 422, code: "SMTP_TIMEOUT" });
  if (["ETLS", "ESOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_SSL_WRONG_VERSION_NUMBER"].includes(error?.code)) return Object.assign(new Error("The SMTP server was reached, but TLS negotiation failed. Check encryption mode and port."), { status: 422, code: "SMTP_TLS_ERROR" });
  if (["EDNS", "ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code)) return Object.assign(new Error("Unable to reach the SMTP server."), { status: 422, code: "SMTP_NETWORK_ERROR" });
  return Object.assign(new Error("The SMTP settings could not be verified. Check the server configuration and try again."), { status: 422, code: "SMTP_VERIFICATION_FAILED" });
}

export function smtpTransportOptions(account) {
  const encryption = account.smtpEncryption || (Number(account.smtpPort) === 587 ? "STARTTLS" : account.smtpSecure ? "SSL_TLS" : "NONE");
  return {
    host: account.smtpHost,
    port: account.smtpPort,
    secure: encryption === "SSL_TLS",
    ...(encryption === "STARTTLS" ? { requireTLS: true } : {}),
    ...(encryption === "NONE" ? { ignoreTLS: true } : {}),
    auth: { user: account.smtpUsername, pass: decryptToken(account.smtpPassword) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

export async function testSendingAccount(id) {
  const account = await prisma.outreachSendingAccount.findUnique({ where: { id } });
  if (!account || account.provider !== "SMTP") throw Object.assign(new Error("SMTP account not found"), { status: 404, code: "SMTP_ACCOUNT_NOT_FOUND" });
  const options = smtpTransportOptions(account);
  const transport = nodemailer.createTransport(options);
  try { await transport.verify(); } catch (error) { throw smtpConfigurationError(error); }
  return { ok: true, diagnostic: { serverReached: true, tlsEstablished: account.smtpEncryption !== "NONE", authentication: "SUCCEEDED", code: "SMTP_VERIFIED" } };
}
export async function unsubscribe(token) { const row = await prisma.agentOutreachProspect.findUnique({ where: { unsubscribeTokenHash: digestSecret(token || "") } }); if (!row?.normalizedEmail) return false; await prisma.$transaction([prisma.outreachSuppression.upsert({ where: { normalizedEmail: row.normalizedEmail }, create: { normalizedEmail: row.normalizedEmail, reason: "UNSUBSCRIBED", source: "EMAIL_LINK" }, update: { reason: "UNSUBSCRIBED", source: "EMAIL_LINK", restoredAt: null } }), prisma.agentOutreachProspect.update({ where: { id: row.id }, data: { status: "UNSUBSCRIBED", events: { create: { type: "unsubscribed" } } } })]); return true; }
export async function syncClaimed(id) { const rows = await prisma.agentOutreachProspect.findMany({ where: { ...(id ? { id } : {}), status: { not: "CLAIMED" }, prospectWorkspace: { claimStatus: "CLAIMED" } }, select: { id: true, prospectWorkspace: { select: { claimedAt: true } } } }); await Promise.all(rows.map(row => prisma.agentOutreachProspect.update({ where: { id: row.id }, data: { status: "CLAIMED", claimedAt: row.prospectWorkspace.claimedAt, events: { create: { type: "claimed" } } } }))); }

export const outreachTemplate = { subject: DEFAULT_SUBJECT, textBody: DEFAULT_BODY, htmlBody: DEFAULT_HTML_BODY };
