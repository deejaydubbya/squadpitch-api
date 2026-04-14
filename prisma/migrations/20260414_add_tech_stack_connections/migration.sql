-- CreateTable
CREATE TABLE "workspace_tech_stack_connections" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionStatus" TEXT NOT NULL DEFAULT 'not_connected',
    "metadataJson" JSONB,
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_tech_stack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_tech_stack_connections_workspaceId_idx" ON "workspace_tech_stack_connections"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_tech_stack_connections_workspaceId_providerKey_key" ON "workspace_tech_stack_connections"("workspaceId", "providerKey");

-- AddForeignKey
ALTER TABLE "workspace_tech_stack_connections" ADD CONSTRAINT "workspace_tech_stack_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
