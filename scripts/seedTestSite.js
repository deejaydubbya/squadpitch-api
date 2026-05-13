// One-shot test fixture: creates a Site + SitePage + LeadForm
// for an existing workspace so we can smoke-test the runtime
// end-to-end via [client].squadpitchsites.com/<slug>.
//
// Idempotent. Picks the workspace by --slug=<client-slug>, finds
// the Client row, then ensures a Site, SitePage, and LeadForm
// exist with stable IDs derived from the slug. Re-running is
// a no-op once the fixture is in place.
//
// Usage:
//   node scripts/seedTestSite.js --slug=<workspace-slug> [--page=<page-slug>]
//
// Production:
//   flyctl ssh console -a squadpitch-api -C \
//     "node scripts/seedTestSite.js --slug=<workspace-slug>"
//
// NOT wired into release_command — this script writes one row per
// table, not a recurring maintenance task.

import { PrismaClient } from "@prisma/client";
import { triggerRuntimeRevalidate } from "../domains/sites/revalidate.client.js";

const prisma = new PrismaClient();

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const match = /^--([a-z]+)=(.+)$/i.exec(a);
    if (match) args[match[1].toLowerCase()] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const clientSlug = args.slug;
  const pageSlug = args.page || "phase-b-test";

  if (!clientSlug) {
    console.error(
      "[seedTestSite] missing --slug=<workspace-slug>. " +
        "Pass the Client.slug of the workspace to seed against.",
    );
    process.exit(1);
  }

  console.log(`[seedTestSite] starting for client=${clientSlug} page=${pageSlug}`);

  const client = await prisma.client.findUnique({
    where: { slug: clientSlug },
    select: { id: true, name: true, createdBy: true },
  });
  if (!client) {
    console.error(`[seedTestSite] no client found with slug=${clientSlug}`);
    process.exit(1);
  }

  // ── Ensure Site exists ────────────────────────────────────────────
  // One Site per workspace (UNIQUE on clientId). Upsert keeps the
  // script idempotent.
  const site = await prisma.site.upsert({
    where: { clientId: client.id },
    update: { status: "PUBLISHED" },
    create: {
      clientId: client.id,
      status: "PUBLISHED",
      createdBy: client.createdBy,
      themeJson: { accent: "#5b9979" },
    },
  });
  console.log(`[seedTestSite] site=${site.id} status=${site.status}`);

  // ── Ensure LeadForm exists ────────────────────────────────────────
  // Find-or-create keyed off a recognizable name so re-runs don't
  // duplicate. UpdatedAt is bumped to force-refresh fields on
  // subsequent runs.
  const formName = "Phase B Test — Contact Form";
  let form = await prisma.leadForm.findFirst({
    where: { clientId: client.id, name: formName },
  });
  const formFields = [
    { key: "name", label: "Your name", type: "text", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "message", label: "Message", type: "textarea", required: false },
  ];
  const successAction = {
    type: "message",
    message: "Thanks — we'll be in touch shortly.",
  };
  if (!form) {
    form = await prisma.leadForm.create({
      data: {
        siteId: site.id,
        clientId: client.id,
        name: formName,
        fieldsJson: formFields,
        successAction,
      },
    });
    console.log(`[seedTestSite] form CREATED id=${form.id}`);
  } else {
    form = await prisma.leadForm.update({
      where: { id: form.id },
      data: { fieldsJson: formFields, successAction },
    });
    console.log(`[seedTestSite] form UPDATED id=${form.id}`);
  }

  // ── Ensure SitePage exists ────────────────────────────────────────
  // Upsert on (clientId, slug). Re-runs refresh content so we can
  // iterate the test page without dropping the row.
  const blocks = [
    {
      type: "hero",
      headline: `Welcome to ${client.name || clientSlug}`,
      subheadline:
        "This is a Phase B test page served by squadpitch-public. The runtime fetched this content from /api/v1/public/sites/resolve, then rendered the blocks below.",
    },
    {
      type: "paragraph",
      body:
        "Block rendering is wired end-to-end. Hero, paragraph, image, CTA, and lead-form blocks each have their own renderer in lib/pageBlocks/. The dispatcher silently skips block types it doesn't recognize so the dashboard can roll out new block types before the runtime catches up.",
    },
    {
      type: "cta",
      label: "See the dashboard",
      href: "https://squadpitch-web.fly.dev",
    },
    {
      type: "lead_form",
      formId: form.id,
    },
  ];

  const pageData = {
    siteId: site.id,
    clientId: client.id,
    slug: pageSlug,
    title: `Phase B Test — ${client.name || clientSlug}`,
    description: "Smoke-test page for the SquadSites public runtime.",
    status: "PUBLISHED",
    blocksJson: blocks,
    publishedAt: new Date(),
    createdBy: client.createdBy,
  };

  const existingPage = await prisma.sitePage.findUnique({
    where: { clientId_slug: { clientId: client.id, slug: pageSlug } },
  });
  let page;
  if (!existingPage) {
    page = await prisma.sitePage.create({ data: pageData });
    console.log(`[seedTestSite] page CREATED id=${page.id} slug=${page.slug}`);
  } else {
    page = await prisma.sitePage.update({
      where: { id: existingPage.id },
      data: { ...pageData, publishedAt: existingPage.publishedAt },
    });
    console.log(`[seedTestSite] page UPDATED id=${page.id} slug=${page.slug}`);
  }

  // Trigger ISR revalidation so the new content shows up
  // immediately on the runtime. Fire-and-forget — no failure
  // surfaces here.
  const result = await triggerRuntimeRevalidate({
    clientSlug,
    pageSlug,
  });
  console.log(
    `[seedTestSite] revalidate ok=${result.ok} status=${result.status} reason=${result.reason ?? "-"}`,
  );

  const baseDomain = process.env.PUBLIC_SITES_BASE_DOMAIN || "squadpitchsites.com";
  console.log(
    `[seedTestSite] done — visit https://${clientSlug}.${baseDomain}/${pageSlug}`,
  );
}

main()
  .catch((err) => {
    console.error("[seedTestSite] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
