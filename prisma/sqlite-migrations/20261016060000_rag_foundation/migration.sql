-- AlterTable
ALTER TABLE "WorkspaceFile" ADD COLUMN "contextVersionUsed" INTEGER;

-- CreateTable
CREATE TABLE "ResearchQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "searchQueries" TEXT NOT NULL DEFAULT '[]',
    "priority" TEXT NOT NULL DEFAULT 'high',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchQuestion_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "currentRevisionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Source_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "rawContent" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "SourceRevision_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SourceRevision_sourceId_packageId_fkey" FOREIGN KEY ("sourceId", "packageId") REFERENCES "Source" ("id", "packageId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EvidenceChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "sourceRevisionId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkerVersion" TEXT NOT NULL,
    "evidenceNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceChunk_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EvidenceChunk_sourceRevisionId_packageId_fkey" FOREIGN KEY ("sourceRevisionId", "packageId") REFERENCES "SourceRevision" ("id", "packageId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmbeddingIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrlFingerprint" TEXT NOT NULL,
    "dimensions" INTEGER,
    "chunkerVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    CONSTRAINT "EmbeddingIndex_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChunkEmbedding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "indexId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "vector" TEXT NOT NULL,
    "vectorNorm" REAL NOT NULL,
    CONSTRAINT "ChunkEmbedding_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChunkEmbedding_indexId_packageId_fkey" FOREIGN KEY ("indexId", "packageId") REFERENCES "EmbeddingIndex" ("id", "packageId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChunkEmbedding_chunkId_packageId_fkey" FOREIGN KEY ("chunkId", "packageId") REFERENCES "EvidenceChunk" ("id", "packageId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "fileVersion" INTEGER NOT NULL,
    "section" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Citation_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Citation_chunkId_packageId_fkey" FOREIGN KEY ("chunkId", "packageId") REFERENCES "EvidenceChunk" ("id", "packageId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "sourceRevisionId" TEXT NOT NULL,
    "indexId" TEXT,
    "jobKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "KnowledgeJob_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KnowledgeJob_sourceRevisionId_packageId_fkey" FOREIGN KEY ("sourceRevisionId", "packageId") REFERENCES "SourceRevision" ("id", "packageId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KnowledgeJob_indexId_packageId_fkey" FOREIGN KEY ("indexId", "packageId") REFERENCES "EmbeddingIndex" ("id", "packageId") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "RetrievalLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "topK" INTEGER NOT NULL,
    "sourceTypes" TEXT NOT NULL,
    "indexId" TEXT,
    "resultEvidenceIds" TEXT NOT NULL,
    "scores" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetrievalLog_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "questionId" TEXT,
    "claim" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "impact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'verified',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evidence_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ResearchPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evidence_questionId_packageId_fkey" FOREIGN KEY ("questionId", "packageId") REFERENCES "ResearchQuestion" ("id", "packageId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
INSERT INTO "new_Evidence" ("claim", "code", "confidence", "createdAt", "id", "impact", "packageId", "question", "sources", "status") SELECT "claim", "code", "confidence", "createdAt", "id", "impact", "packageId", "question", "sources", "status" FROM "Evidence";
DROP TABLE "Evidence";
ALTER TABLE "new_Evidence" RENAME TO "Evidence";
CREATE UNIQUE INDEX "Evidence_packageId_code_key" ON "Evidence"("packageId", "code");
CREATE TABLE "new_ResearchPackage" (
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
    "pendingMessage" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "eventSequence" INTEGER NOT NULL DEFAULT 0,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "contextVersion" INTEGER NOT NULL DEFAULT 0,
    "activeIndexId" TEXT,
    "nextEvidenceNumber" INTEGER NOT NULL DEFAULT 0,
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ResearchPackage" ("constraints", "contextVersion", "createdAt", "currentStage", "eventSequence", "goal", "id", "leaseOwner", "leaseUntil", "pendingMessage", "questionCount", "researchPlan", "scenarioType", "searchCount", "sessionId", "sessionState", "status", "summary", "taskState", "title", "updatedAt", "uploadedFiles") SELECT "constraints", "contextVersion", "createdAt", "currentStage", "eventSequence", "goal", "id", "leaseOwner", "leaseUntil", "pendingMessage", "questionCount", "researchPlan", "scenarioType", "searchCount", "sessionId", "sessionState", "status", "summary", "taskState", "title", "updatedAt", "uploadedFiles" FROM "ResearchPackage";
DROP TABLE "ResearchPackage";
ALTER TABLE "new_ResearchPackage" RENAME TO "ResearchPackage";
CREATE UNIQUE INDEX "ResearchPackage_sessionId_key" ON "ResearchPackage"("sessionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ResearchQuestion_id_packageId_key" ON "ResearchQuestion"("id", "packageId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchQuestion_packageId_ordinal_key" ON "ResearchQuestion"("packageId", "ordinal");

-- CreateIndex
CREATE INDEX "Source_packageId_sourceType_idx" ON "Source"("packageId", "sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "Source_id_packageId_key" ON "Source"("id", "packageId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_packageId_sourceKey_key" ON "Source"("packageId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRevision_id_packageId_key" ON "SourceRevision"("id", "packageId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRevision_sourceId_contentHash_key" ON "SourceRevision"("sourceId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRevision_sourceId_revision_key" ON "SourceRevision"("sourceId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceChunk_id_packageId_key" ON "EvidenceChunk"("id", "packageId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceChunk_packageId_evidenceNumber_key" ON "EvidenceChunk"("packageId", "evidenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceChunk_sourceRevisionId_chunkerVersion_chunkIndex_key" ON "EvidenceChunk"("sourceRevisionId", "chunkerVersion", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingIndex_id_packageId_key" ON "EmbeddingIndex"("id", "packageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingIndex_packageId_generation_key" ON "EmbeddingIndex"("packageId", "generation");

-- CreateIndex
CREATE INDEX "ChunkEmbedding_packageId_indexId_id_idx" ON "ChunkEmbedding"("packageId", "indexId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChunkEmbedding_indexId_chunkId_key" ON "ChunkEmbedding"("indexId", "chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "Citation_packageId_documentName_fileVersion_section_chunkId_key" ON "Citation"("packageId", "documentName", "fileVersion", "section", "chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeJob_jobKey_key" ON "KnowledgeJob"("jobKey");

-- CreateIndex
CREATE INDEX "KnowledgeJob_packageId_status_nextAttemptAt_idx" ON "KnowledgeJob"("packageId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "RetrievalLog_packageId_createdAt_idx" ON "RetrievalLog"("packageId", "createdAt");
