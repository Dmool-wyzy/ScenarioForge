CREATE TABLE `UserProfile` (
  `userId` VARCHAR(100) NOT NULL,
  `nickname` VARCHAR(40) NOT NULL DEFAULT '',
  `avatar` VARCHAR(20) NOT NULL DEFAULT 'leaf',
  `bio` VARCHAR(500) NOT NULL DEFAULT '',
  `specialty` VARCHAR(100) NOT NULL DEFAULT '',
  `skills` VARCHAR(1000) NOT NULL DEFAULT '[]',
  `agentStyle` VARCHAR(20) NOT NULL DEFAULT 'balanced',
  `agentTech` VARCHAR(500) NOT NULL DEFAULT '',
  `agentDelivery` VARCHAR(500) NOT NULL DEFAULT '',
  `agentNotes` VARCHAR(1000) NOT NULL DEFAULT '',
  PRIMARY KEY (`userId`),
  CONSTRAINT `UserProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `PersonalFavorite` (
  `id` VARCHAR(100) NOT NULL,
  `userId` VARCHAR(100) NOT NULL,
  `kind` VARCHAR(20) NOT NULL,
  `targetId` VARCHAR(240) NOT NULL,
  `tags` VARCHAR(1000) NOT NULL DEFAULT '[]',
  `note` VARCHAR(1000) NOT NULL DEFAULT '',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `PersonalFavorite_userId_kind_targetId_key` (`userId`, `kind`, `targetId`),
  INDEX `PersonalFavorite_userId_createdAt_idx` (`userId`, `createdAt`),
  CONSTRAINT `PersonalFavorite_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `AuthSession` ADD COLUMN `id` VARCHAR(100) NULL, ADD COLUMN `device` VARCHAR(100) NOT NULL DEFAULT '历史登录设备';
UPDATE `AuthSession` SET `id` = UUID() WHERE `id` IS NULL;
ALTER TABLE `AuthSession` MODIFY `id` VARCHAR(100) NOT NULL, ADD UNIQUE INDEX `AuthSession_id_key` (`id`);
