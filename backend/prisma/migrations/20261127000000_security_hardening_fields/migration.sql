-- AlterTable
ALTER TABLE "User" ADD COLUMN "accessToken" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "allowForkBuilds" BOOLEAN NOT NULL DEFAULT false;
