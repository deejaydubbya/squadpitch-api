-- CreateTable
CREATE TABLE "workspace_analytics" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "avgEngagementRate" DOUBLE PRECISION,
    "avgPerformanceScore" DOUBLE PRECISION,
    "totalPosts" INTEGER NOT NULL DEFAULT 0,
    "totalPublishedPosts" INTEGER NOT NULL DEFAULT 0,
    "totalReach" INTEGER NOT NULL DEFAULT 0,
    "totalEngagements" INTEGER NOT NULL DEFAULT 0,
    "topPlatform" TEXT,
    "bestContentType" TEXT,
    "bestMediaType" TEXT,
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "avgPerformanceScore" DOUBLE PRECISION,
    "avgEngagementRate" DOUBLE PRECISION,
    "totalPosts" INTEGER NOT NULL DEFAULT 0,
    "totalReach" INTEGER NOT NULL DEFAULT 0,
    "totalEngagements" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_analytics_clientId_key" ON "workspace_analytics"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_clientId_snapshotDate_key" ON "analytics_snapshots"("clientId", "snapshotDate");

-- CreateIndex
CREATE INDEX "analytics_snapshots_clientId_snapshotDate_idx" ON "analytics_snapshots"("clientId", "snapshotDate");

-- AddForeignKey
ALTER TABLE "workspace_analytics" ADD CONSTRAINT "workspace_analytics_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
