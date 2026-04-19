-- CreateEnum
CREATE TYPE "ConversionEventType" AS ENUM ('LINK_CLICK', 'FORM_SUBMISSION', 'CALL_BOOKED', 'CONTACT_CLICK', 'LISTING_INQUIRY', 'CRM_LEAD', 'CUSTOM');

-- CreateTable
CREATE TABLE "trackable_links" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "draftId" TEXT,
    "shortCode" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "label" TEXT,
    "channel" "Channel",
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trackable_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_events" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "draftId" TEXT,
    "trackableLinkId" TEXT,
    "type" "ConversionEventType" NOT NULL,
    "label" TEXT,
    "referrerUrl" TEXT,
    "userAgentHash" TEXT,
    "ipHash" TEXT,
    "country" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trackable_links_shortCode_key" ON "trackable_links"("shortCode");

-- CreateIndex
CREATE INDEX "trackable_links_clientId_idx" ON "trackable_links"("clientId");

-- CreateIndex
CREATE INDEX "trackable_links_draftId_idx" ON "trackable_links"("draftId");

-- CreateIndex
CREATE INDEX "conversion_events_clientId_type_idx" ON "conversion_events"("clientId", "type");

-- CreateIndex
CREATE INDEX "conversion_events_clientId_createdAt_idx" ON "conversion_events"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "conversion_events_draftId_idx" ON "conversion_events"("draftId");

-- CreateIndex
CREATE INDEX "conversion_events_trackableLinkId_idx" ON "conversion_events"("trackableLinkId");

-- AddForeignKey
ALTER TABLE "trackable_links" ADD CONSTRAINT "trackable_links_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trackable_links" ADD CONSTRAINT "trackable_links_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_trackableLinkId_fkey" FOREIGN KEY ("trackableLinkId") REFERENCES "trackable_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
