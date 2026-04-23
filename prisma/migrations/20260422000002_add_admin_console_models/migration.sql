-- CreateTable
CREATE TABLE "external_services" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "criticality" TEXT NOT NULL DEFAULT 'standard',
    "environment" TEXT NOT NULL DEFAULT 'production',
    "consoleUrl" TEXT,
    "docsUrl" TEXT,
    "notes" TEXT,
    "usedByFeatures" TEXT,
    "recoveryNotes" TEXT,
    "fallbackInfo" TEXT,
    "planName" TEXT,
    "billingCycle" TEXT,
    "renewalDate" TIMESTAMP(3),
    "monthlyCostCents" INTEGER,
    "hardLimit" DOUBLE PRECISION,
    "softLimit" DOUBLE PRECISION,
    "currentUsage" DOUBLE PRECISION,
    "usageUnit" TEXT,
    "usageSource" TEXT NOT NULL DEFAULT 'manual',
    "percentUsed" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_service_usage_snapshots" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "usage" DOUBLE PRECISION NOT NULL,
    "limit" DOUBLE PRECISION,
    "percentUsed" DOUBLE PRECISION,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_service_usage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_testers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "workspaceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "cohort" TEXT,
    "tags" TEXT[],
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "contactNotes" TEXT,
    "featureFlags" JSONB,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beta_testers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_feedback" (
    "id" TEXT NOT NULL,
    "testerId" TEXT,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'general',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "route" TEXT,
    "screenshotUrl" TEXT,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "featureFlags" JSONB,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'new',
    "assignee" TEXT,
    "internalNotes" TEXT,
    "needsFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beta_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_services_key_key" ON "external_services"("key");

-- CreateIndex
CREATE INDEX "external_services_category_idx" ON "external_services"("category");

-- CreateIndex
CREATE INDEX "external_services_status_idx" ON "external_services"("status");

-- CreateIndex
CREATE INDEX "external_service_usage_snapshots_serviceId_snapshotAt_idx" ON "external_service_usage_snapshots"("serviceId", "snapshotAt");

-- CreateIndex
CREATE UNIQUE INDEX "beta_testers_userId_key" ON "beta_testers"("userId");

-- CreateIndex
CREATE INDEX "beta_testers_status_idx" ON "beta_testers"("status");

-- CreateIndex
CREATE INDEX "beta_testers_cohort_idx" ON "beta_testers"("cohort");

-- CreateIndex
CREATE INDEX "beta_testers_workspaceId_idx" ON "beta_testers"("workspaceId");

-- CreateIndex
CREATE INDEX "beta_feedback_status_idx" ON "beta_feedback"("status");

-- CreateIndex
CREATE INDEX "beta_feedback_testerId_idx" ON "beta_feedback"("testerId");

-- CreateIndex
CREATE INDEX "beta_feedback_userId_idx" ON "beta_feedback"("userId");

-- CreateIndex
CREATE INDEX "beta_feedback_severity_idx" ON "beta_feedback"("severity");

-- CreateIndex
CREATE INDEX "beta_feedback_needsFollowUp_idx" ON "beta_feedback"("needsFollowUp");

-- AddForeignKey
ALTER TABLE "external_service_usage_snapshots" ADD CONSTRAINT "external_service_usage_snapshots_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "external_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beta_feedback" ADD CONSTRAINT "beta_feedback_testerId_fkey" FOREIGN KEY ("testerId") REFERENCES "beta_testers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
