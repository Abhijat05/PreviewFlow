-- CreateTable
CREATE TABLE "PortAllocation" (
    "port" INTEGER NOT NULL,
    "previewId" TEXT,
    "buildId" TEXT,
    "tier" "UserTier" NOT NULL DEFAULT 'FREE',
    "isAllocated" BOOLEAN NOT NULL DEFAULT false,
    "allocatedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortAllocation_pkey" PRIMARY KEY ("port")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortAllocation_buildId_key" ON "PortAllocation"("buildId");

-- CreateIndex
CREATE INDEX "PortAllocation_tier_isAllocated_idx" ON "PortAllocation"("tier", "isAllocated");

-- CreateIndex
CREATE INDEX "PortAllocation_previewId_idx" ON "PortAllocation"("previewId");

-- AddForeignKey
ALTER TABLE "PortAllocation" ADD CONSTRAINT "PortAllocation_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "Preview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortAllocation" ADD CONSTRAINT "PortAllocation_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE SET NULL ON UPDATE CASCADE;
