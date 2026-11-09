ALTER TABLE `ResearchPackage`
    ADD COLUMN `agentTaskCount` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `AgentSubtask` (
    `id` VARCHAR(100) NOT NULL,
    `packageId` VARCHAR(100) NOT NULL,
    `runId` VARCHAR(100) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `objective` LONGTEXT NOT NULL,
    `context` LONGTEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'running',
    `result` LONGTEXT NULL,
    `error` VARCHAR(500) NULL,
    `modelRequests` INTEGER NOT NULL DEFAULT 0,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AgentSubtask_run_ordinal_key`(`runId`, `ordinal`),
    INDEX `AgentSubtask_package_created_idx`(`packageId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AgentSubtask_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `ResearchPackage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
