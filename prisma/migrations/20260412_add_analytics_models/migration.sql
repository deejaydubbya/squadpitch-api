-- CreateTable
CREATE TABLE "raw_metrics" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalPostId" TEXT,
    "dataJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "normalized_metrics" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "impressions" INTEGER,
    "reach" INTEGER,
    "engagements" INTEGER,
    "clicks" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "relativeEngagementRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "normalized_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_insights" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "performanceScore" DOUBLE PRECISION,
    "contentType" TEXT,
    "hookType" TEXT,
    "sentiment" TEXT,
    "lengthBucket" TEXT,
    "mediaType" TEXT,
    "postingTimeBucket" TEXT,
    "recommendationTags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "raw_metrics_clientId_idx" ON "raw_metrics"("clientId");

-- CreateIndex
CREATE INDEX "raw_metrics_draftId_idx" ON "raw_metrics"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_metrics_draftId_key" ON "normalized_metrics"("draftId");

-- CreateIndex
CREATE INDEX "normalized_metrics_clientId_channel_idx" ON "normalized_metrics"("clientId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "post_insights_draftId_key" ON "post_insights"("draftId");

-- CreateIndex
CREATE INDEX "post_insights_clientId_idx" ON "post_insights"("clientId");

-- AddForeignKey
ALTER TABLE "raw_metrics" ADD CONSTRAINT "raw_metrics_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_metrics" ADD CONSTRAINT "raw_metrics_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_metrics" ADD CONSTRAINT "normalized_metrics_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_metrics" ADD CONSTRAINT "normalized_metrics_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_insights" ADD CONSTRAINT "post_insights_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_insights" ADD CONSTRAINT "post_insights_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
