CREATE TABLE "internal_entitlements" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "grantedBySub" TEXT NOT NULL,
    "grantedByEmail" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedBySub" TEXT,
    "revokedByEmail" TEXT,
    "revokedReason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "internal_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_entitlements_clientId_key" ON "internal_entitlements"("clientId");
CREATE INDEX "internal_entitlements_active_tier_idx" ON "internal_entitlements"("active", "tier");
ALTER TABLE "internal_entitlements" ADD CONSTRAINT "internal_entitlements_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
