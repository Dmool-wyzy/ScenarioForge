CREATE TABLE `LocalRunner` (
  `id` VARCHAR(100) NOT NULL, `projectId` VARCHAR(100) NOT NULL, `userId` VARCHAR(100) NOT NULL,
  `label` VARCHAR(80) NOT NULL, `pairingHash` CHAR(64) NULL, `pairingExpires` DATETIME(3) NOT NULL,
  `tokenHash` CHAR(64) NULL, `expiresAt` DATETIME(3) NOT NULL, `revokedAt` DATETIME(3) NULL,
  `lastSeenAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE INDEX `LocalRunner_pairingHash_key` (`pairingHash`),
  UNIQUE INDEX `LocalRunner_tokenHash_key` (`tokenHash`), INDEX `LocalRunner_projectId_userId_idx` (`projectId`, `userId`),
  CONSTRAINT `LocalRunner_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `LocalRunner_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `WorkspaceExecution` ADD COLUMN `target` VARCHAR(16) NOT NULL DEFAULT 'github',
  ADD COLUMN `runnerId` VARCHAR(100) NULL, ADD COLUMN `localReview` LONGTEXT NULL,
  ADD INDEX `WorkspaceExecution_runnerId_status_idx` (`runnerId`, `status`),
  ADD CONSTRAINT `WorkspaceExecution_runnerId_fkey` FOREIGN KEY (`runnerId`) REFERENCES `LocalRunner` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE `LocalRunnerCommand` (
  `id` VARCHAR(100) NOT NULL, `runnerId` VARCHAR(100) NOT NULL, `executionId` VARCHAR(100) NOT NULL,
  `leaseOwner` VARCHAR(100) NULL, `executionLease` VARCHAR(100) NOT NULL, `operation` VARCHAR(20) NOT NULL, `input` LONGTEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending', `result` LONGTEXT NULL, `error` VARCHAR(500) NULL,
  `expiresAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), INDEX `LocalRunnerCommand_runnerId_status_createdAt_idx` (`runnerId`, `status`, `createdAt`),
  CONSTRAINT `LocalRunnerCommand_runnerId_fkey` FOREIGN KEY (`runnerId`) REFERENCES `LocalRunner` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `LocalRunnerCommand_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `WorkspaceExecution` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
