-- CreateEnum
CREATE TYPE "BuildStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BuildSource" AS ENUM ('WEBHOOK_OPEN', 'WEBHOOK_SYNC', 'WEBHOOK_REOPEN', 'MANUAL_REBUILD', 'DEV_SIMULATION');

-- AlterTable
ALTER TABLE "Preview" ADD COLUMN "activeBuildId" TEXT,
ADD COLUMN "desiredCommitSha" TEXT,
ADD COLUMN "deployedCommitSha" TEXT,
ADD COLUMN "latestBuildId" TEXT;

-- CreateTable
CREATE TABLE "Build" (
    "id" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "buildNumber" INTEGER NOT NULL,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT,
    "branch" TEXT NOT NULL,
    "source" "BuildSource" NOT NULL DEFAULT 'WEBHOOK_SYNC',
    "status" "BuildStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "workerId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "imageTag" TEXT,
    "containerName" TEXT,
    "port" INTEGER,
    "buildLogs" TEXT,
    "errorMessage" TEXT,
    "exitCode" INTEGER,

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Build_previewId_status_idx" ON "Build"("previewId", "status");

-- CreateIndex
CREATE INDEX "Build_status_queuedAt_idx" ON "Build"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "Build_workerId_leaseExpiresAt_idx" ON "Build"("workerId", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Build_previewId_buildNumber_key" ON "Build"("previewId", "buildNumber");

-- AddForeignKey
ALTER TABLE "Preview" ADD CONSTRAINT "Preview_activeBuildId_fkey" FOREIGN KEY ("activeBuildId") REFERENCES "Build"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "Preview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
