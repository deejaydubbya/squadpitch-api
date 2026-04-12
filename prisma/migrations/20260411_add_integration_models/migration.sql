-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_logs" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "responseData" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrations_userId_type_idx" ON "integrations"("userId", "type");

-- CreateIndex
CREATE INDEX "integration_logs_integrationId_createdAt_idx" ON "integration_logs"("integrationId", "createdAt");

-- AddForeignKey
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
