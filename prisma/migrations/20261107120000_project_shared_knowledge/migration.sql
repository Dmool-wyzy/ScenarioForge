CREATE TABLE `ProjectKnowledgeItem` (
    `id` VARCHAR(100) NOT NULL,
    `projectId` VARCHAR(100) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `question` LONGTEXT NOT NULL,
    `claim` LONGTEXT NOT NULL,
    `sources` LONGTEXT NOT NULL,
    `confidence` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `originPackageId` VARCHAR(100) NOT NULL,
    `originPackageTitle` VARCHAR(200) NOT NULL,
    `originEvidenceId` VARCHAR(100) NOT NULL,
    `originEvidenceCode` VARCHAR(32) NOT NULL,
    `createdBy` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ProjectKnowledgeItem_project_origin_evidence_key`(`projectId`, `originPackageId`, `originEvidenceId`),
    INDEX `ProjectKnowledgeItem_projectId_archivedAt_createdAt_idx`(`projectId`, `archivedAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProjectKnowledgeItem` ADD CONSTRAINT `ProjectKnowledgeItem_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
