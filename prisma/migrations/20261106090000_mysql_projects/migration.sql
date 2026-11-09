-- CreateTable
CREATE TABLE `ResearchPackage` (
    `projectId` VARCHAR(100) NULL,
    `id` VARCHAR(100) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `goal` LONGTEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'created',
    `scenarioType` VARCHAR(191) NULL,
    `constraints` LONGTEXT NULL,
    `currentStage` INTEGER NOT NULL DEFAULT 0,
    `uploadedFiles` LONGTEXT NOT NULL DEFAULT ('[]'),
    `researchPlan` LONGTEXT NULL,
    `sessionId` VARCHAR(100) NOT NULL,
    `sessionState` LONGTEXT NOT NULL DEFAULT ('[]'),
    `summary` LONGTEXT NULL,
    `taskState` VARCHAR(191) NOT NULL DEFAULT 'idle',
    `pendingMessage` LONGTEXT NULL,
    `leaseOwner` VARCHAR(100) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `eventSequence` INTEGER NOT NULL DEFAULT 0,
    `searchCount` INTEGER NOT NULL DEFAULT 0,
    `questionCount` INTEGER NOT NULL DEFAULT 0,
    `contextVersion` INTEGER NOT NULL DEFAULT 0,
    `activeIndexId` VARCHAR(100) NULL,
    `nextEvidenceNumber` INTEGER NOT NULL DEFAULT 0,
    `planVersion` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ResearchPackage_sessionId_key`(`sessionId`),
    INDEX `ResearchPackage_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkspaceFile` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `filename` VARCHAR(191) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedBy` VARCHAR(191) NOT NULL DEFAULT 'agent',
    `changeNote` LONGTEXT NULL,
    `lockedBy` VARCHAR(191) NULL,
    `lockToken` VARCHAR(191) NULL,
    `lockExpiresAt` DATETIME(3) NULL,
    `userContent` LONGTEXT NULL,
    `contextVersionUsed` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WorkspaceFile_packageId_filename_key`(`packageId`, `filename`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Evidence` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `question` LONGTEXT NOT NULL,
    `questionId` VARCHAR(100) NULL,
    `claim` LONGTEXT NOT NULL,
    `sources` LONGTEXT NOT NULL,
    `confidence` VARCHAR(191) NOT NULL,
    `impact` LONGTEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'verified',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Evidence_packageId_code_key`(`packageId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Clarification` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `groupId` VARCHAR(100) NOT NULL,
    `question` LONGTEXT NOT NULL,
    `questionId` VARCHAR(100) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'text',
    `options` LONGTEXT NULL,
    `priority` VARCHAR(191) NOT NULL DEFAULT 'optional',
    `whyNeeded` LONGTEXT NOT NULL,
    `defaultAssumption` LONGTEXT NULL,
    `answer` LONGTEXT NULL,
    `answeredBy` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'waiting',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `answeredAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `Clarification_packageId_groupId_idx`(`packageId`, `groupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ResearchEvent` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` LONGTEXT NOT NULL,
    `payload` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ResearchEvent_packageId_sequence_key`(`packageId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ResearchQuestion` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `question` LONGTEXT NOT NULL,
    `searchQueries` LONGTEXT NOT NULL DEFAULT ('[]'),
    `priority` VARCHAR(191) NOT NULL DEFAULT 'high',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastError` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ResearchQuestion_id_packageId_key`(`id`, `packageId`),
    UNIQUE INDEX `ResearchQuestion_packageId_ordinal_key`(`packageId`, `ordinal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Source` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `sourceType` VARCHAR(191) NOT NULL,
    `sourceKey` VARCHAR(500) NOT NULL,
    `title` LONGTEXT NOT NULL,
    `url` LONGTEXT NULL,
    `metadata` LONGTEXT NOT NULL DEFAULT ('{}'),
    `currentRevisionId` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Source_packageId_sourceType_idx`(`packageId`, `sourceType`),
    UNIQUE INDEX `Source_id_packageId_key`(`id`, `packageId`),
    UNIQUE INDEX `Source_packageId_sourceKey_key`(`packageId`, `sourceKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SourceRevision` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `sourceId` VARCHAR(100) NOT NULL,
    `revision` INTEGER NOT NULL,
    `rawContent` LONGTEXT NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `metadata` LONGTEXT NOT NULL DEFAULT ('{}'),

    UNIQUE INDEX `SourceRevision_id_packageId_key`(`id`, `packageId`),
    UNIQUE INDEX `SourceRevision_sourceId_contentHash_key`(`sourceId`, `contentHash`),
    UNIQUE INDEX `SourceRevision_sourceId_revision_key`(`sourceId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EvidenceChunk` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `sourceRevisionId` VARCHAR(100) NOT NULL,
    `chunkIndex` INTEGER NOT NULL,
    `chunkerVersion` VARCHAR(191) NOT NULL,
    `evidenceNumber` INTEGER NOT NULL,
    `content` LONGTEXT NOT NULL,
    `tokenCount` INTEGER NOT NULL,
    `metadata` LONGTEXT NOT NULL DEFAULT ('{}'),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EvidenceChunk_id_packageId_key`(`id`, `packageId`),
    UNIQUE INDEX `EvidenceChunk_packageId_evidenceNumber_key`(`packageId`, `evidenceNumber`),
    UNIQUE INDEX `EvidenceChunk_sourceRevisionId_chunkerVersion_chunkIndex_key`(`sourceRevisionId`, `chunkerVersion`, `chunkIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmbeddingIndex` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `generation` INTEGER NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `baseUrlFingerprint` VARCHAR(191) NOT NULL,
    `dimensions` INTEGER NULL,
    `chunkerVersion` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'building',
    `errorCode` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `activatedAt` DATETIME(3) NULL,

    UNIQUE INDEX `EmbeddingIndex_id_packageId_key`(`id`, `packageId`),
    UNIQUE INDEX `EmbeddingIndex_packageId_generation_key`(`packageId`, `generation`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChunkEmbedding` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `indexId` VARCHAR(100) NOT NULL,
    `chunkId` VARCHAR(100) NOT NULL,
    `vector` LONGTEXT NOT NULL,
    `vectorNorm` DOUBLE NOT NULL,

    INDEX `ChunkEmbedding_packageId_indexId_id_idx`(`packageId`, `indexId`, `id`),
    UNIQUE INDEX `ChunkEmbedding_indexId_chunkId_key`(`indexId`, `chunkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Citation` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `chunkId` VARCHAR(100) NOT NULL,
    `documentName` VARCHAR(100) NOT NULL,
    `fileVersion` INTEGER NOT NULL,
    `section` VARCHAR(300) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Citation_packageId_documentName_fileVersion_section_chunkId_key`(`packageId`, `documentName`, `fileVersion`, `section`, `chunkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeJob` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `sourceRevisionId` VARCHAR(100) NOT NULL,
    `indexId` VARCHAR(100) NULL,
    `jobKey` VARCHAR(255) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leaseOwner` VARCHAR(100) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `errorCode` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `KnowledgeJob_jobKey_key`(`jobKey`),
    INDEX `KnowledgeJob_packageId_status_nextAttemptAt_idx`(`packageId`, `status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RetrievalLog` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `query` LONGTEXT NOT NULL,
    `topK` INTEGER NOT NULL,
    `sourceTypes` LONGTEXT NOT NULL,
    `indexId` VARCHAR(100) NULL,
    `resultEvidenceIds` LONGTEXT NOT NULL,
    `scores` LONGTEXT NOT NULL,
    `durationMs` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RetrievalLog_packageId_createdAt_idx`(`packageId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(100) NOT NULL,
    `username` VARCHAR(64) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `User_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuthSession` (
    `tokenHash` CHAR(64) NOT NULL,
    `userId` VARCHAR(100) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuthSession_userId_idx`(`userId`),
    PRIMARY KEY (`tokenHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(100) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `inviteCode` CHAR(6) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Project_inviteCode_key`(`inviteCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectMember` (
    `projectId` VARCHAR(100) NOT NULL,
    `userId` VARCHAR(100) NOT NULL,
    `role` VARCHAR(16) NOT NULL DEFAULT 'member',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProjectMember_userId_idx`(`userId`),
    PRIMARY KEY (`projectId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ResearchPackage` ADD CONSTRAINT `ResearchPackage_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkspaceFile` ADD CONSTRAINT `WorkspaceFile_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Evidence` ADD CONSTRAINT `Evidence_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Evidence` ADD CONSTRAINT `Evidence_questionId_packageId_fkey` FOREIGN KEY (`questionId`, `packageId`) REFERENCES `ResearchQuestion`(`id`, `packageId`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `Clarification` ADD CONSTRAINT `Clarification_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResearchEvent` ADD CONSTRAINT `ResearchEvent_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResearchQuestion` ADD CONSTRAINT `ResearchQuestion_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Source` ADD CONSTRAINT `Source_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SourceRevision` ADD CONSTRAINT `SourceRevision_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SourceRevision` ADD CONSTRAINT `SourceRevision_sourceId_packageId_fkey` FOREIGN KEY (`sourceId`, `packageId`) REFERENCES `Source`(`id`, `packageId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EvidenceChunk` ADD CONSTRAINT `EvidenceChunk_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EvidenceChunk` ADD CONSTRAINT `EvidenceChunk_sourceRevisionId_packageId_fkey` FOREIGN KEY (`sourceRevisionId`, `packageId`) REFERENCES `SourceRevision`(`id`, `packageId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmbeddingIndex` ADD CONSTRAINT `EmbeddingIndex_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChunkEmbedding` ADD CONSTRAINT `ChunkEmbedding_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChunkEmbedding` ADD CONSTRAINT `ChunkEmbedding_indexId_packageId_fkey` FOREIGN KEY (`indexId`, `packageId`) REFERENCES `EmbeddingIndex`(`id`, `packageId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChunkEmbedding` ADD CONSTRAINT `ChunkEmbedding_chunkId_packageId_fkey` FOREIGN KEY (`chunkId`, `packageId`) REFERENCES `EvidenceChunk`(`id`, `packageId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Citation` ADD CONSTRAINT `Citation_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Citation` ADD CONSTRAINT `Citation_chunkId_packageId_fkey` FOREIGN KEY (`chunkId`, `packageId`) REFERENCES `EvidenceChunk`(`id`, `packageId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeJob` ADD CONSTRAINT `KnowledgeJob_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeJob` ADD CONSTRAINT `KnowledgeJob_sourceRevisionId_packageId_fkey` FOREIGN KEY (`sourceRevisionId`, `packageId`) REFERENCES `SourceRevision`(`id`, `packageId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeJob` ADD CONSTRAINT `KnowledgeJob_indexId_packageId_fkey` FOREIGN KEY (`indexId`, `packageId`) REFERENCES `EmbeddingIndex`(`id`, `packageId`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `RetrievalLog` ADD CONSTRAINT `RetrievalLog_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuthSession` ADD CONSTRAINT `AuthSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectMember` ADD CONSTRAINT `ProjectMember_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectMember` ADD CONSTRAINT `ProjectMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
