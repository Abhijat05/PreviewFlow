-- CreateTable
CREATE TABLE "PreviewMetric" (
    "id" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "cpu" DOUBLE PRECISION NOT NULL,
    "memory" BIGINT NOT NULL,
    "networkRx" BIGINT,
    "networkTx" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreviewMetric_previewId_createdAt_idx" ON "PreviewMetric"("previewId", "createdAt");

-- AddForeignKey
ALTER TABLE "PreviewMetric" ADD CONSTRAINT "PreviewMetric_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "Preview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
