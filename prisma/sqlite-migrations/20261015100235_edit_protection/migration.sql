-- AlterTable
ALTER TABLE "WorkspaceFile" ADD COLUMN "lockExpiresAt" DATETIME;
ALTER TABLE "WorkspaceFile" ADD COLUMN "lockToken" TEXT;
ALTER TABLE "WorkspaceFile" ADD COLUMN "userContent" TEXT;
