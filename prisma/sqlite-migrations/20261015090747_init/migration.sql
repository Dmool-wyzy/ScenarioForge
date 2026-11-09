-- CreateTable
CREATE TABLE "ResearchPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "scenarioType" TEXT,
    "constraints" TEXT,
    "currentStage" INTEGER NOT NULL DEFAULT 0,
    "uploadedFiles" TEXT NOT NULL DEFAULT '[]',
    "researchPlan" TEXT,
    "sessionId" TEXT NOT NULL,
    "sessionState" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "taskState" TEXT NOT NULL DEFAULT 'idle',
    "leaseUntil" DATETIME,
    "eventSequence" INTEGER NOT NULL DEFAULT 0,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "contextVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkspaceFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL DEFAULT 'agent',
    "changeNote" TEXT,
    "lockedBy" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceFile_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "impact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'verified',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evidence_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Clarification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "options" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'optional',
    "whyNeeded" TEXT NOT NULL,
    "defaultAssumption" TEXT,
    "answer" TEXT,
    "answeredBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Clarification_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchEvent_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchPackage_sessionId_key" ON "ResearchPackage"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceFile_packageId_filename_key" ON "WorkspaceFile"("packageId", "filename");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_packageId_code_key" ON "Evidence"("packageId", "code");

-- CreateIndex
CREATE INDEX "Clarification_packageId_groupId_idx" ON "Clarification"("packageId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchEvent_packageId_sequence_key" ON "ResearchEvent"("packageId", "sequence");
