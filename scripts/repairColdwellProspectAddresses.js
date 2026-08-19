import { prisma } from "../prisma.js";

const apply = process.argv.includes("--apply");
const includeEmailed = process.argv.includes("--include-emailed");
const TITLE_ADDRESS_RE = /^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/i;
const CORRUPT_STREET_RE = /^\d{5}(?:-\d{4})?\d+\s/i;

function repairCandidate(item) {
  const data = item.dataJson && typeof item.dataJson === "object" ? item.dataJson : {};
  const sourceUrl = data._sourceUrl || data.listingUrl;
  if (!/coldwellbankerhomes\.com/i.test(sourceUrl || "") || !CORRUPT_STREET_RE.test(data.street || "")) return null;
  const match = item.title?.match(TITLE_ADDRESS_RE);
  if (!match) return null;
  const [, street, city, state, postalCode] = match;
  if (!data.street.startsWith(postalCode) || (data.zip && data.zip !== postalCode)) return null;
  return { oldStreet: data.street, street, city, state: state.toUpperCase(), postalCode, sourceUrl };
}

try {
  const items = await prisma.workspaceDataItem.findMany({
    where: { type: "PROPERTY", client: { lifecycle: "PROSPECT" } },
    include: { client: { select: { prospectWorkspace: { select: { claimStatus: true, outreachProspect: { select: { emailSentAt: true } } } } } } },
  });
  const candidates = items.map((item) => ({ item, repair: repairCandidate(item) })).filter(({ repair }) => repair);
  let eligible = 0, repaired = 0;
  for (const { item, repair } of candidates) {
    const workspace = item.client.prospectWorkspace;
    const safeToApply = workspace?.claimStatus === "CLAIMABLE" && (includeEmailed || !workspace.outreachProspect?.emailSentAt);
    if (safeToApply) eligible += 1;
    console.log(JSON.stringify({ itemId: item.id, oldStreet: repair.oldStreet, street: repair.street, city: repair.city, state: repair.state, postalCode: repair.postalCode, safeToApply }));
    if (!apply || !safeToApply) continue;
    const drafts = await prisma.draft.findMany({ where: { clientId: item.clientId, warnings: { has: `prospectProperty:${item.id}` } }, select: { id: true, body: true } });
    await prisma.$transaction([
      prisma.workspaceDataItem.update({ where: { id: item.id }, data: { dataJson: { ...item.dataJson, street: repair.street, city: repair.city, state: repair.state, zip: repair.postalCode } } }),
      ...drafts.filter((draft) => draft.body.includes(repair.oldStreet)).map((draft) => prisma.draft.update({ where: { id: draft.id }, data: { body: draft.body.replaceAll(repair.oldStreet, repair.street) } })),
    ]);
    repaired += 1;
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", found: candidates.length, eligible, repaired }));
} finally {
  await prisma.$disconnect();
}
