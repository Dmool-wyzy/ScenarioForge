CREATE TABLE `PersonalProjectPriority` (
  `projectId` VARCHAR(100) NOT NULL,
  `userId` VARCHAR(100) NOT NULL,
  `stars` INTEGER NOT NULL DEFAULT 3,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`projectId`, `userId`),
  INDEX `PersonalProjectPriority_userId_idx` (`userId`),
  CONSTRAINT `PersonalProjectPriority_member_fkey` FOREIGN KEY (`projectId`, `userId`) REFERENCES `ProjectMember` (`projectId`, `userId`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PersonalActionSetting` (
  `projectId` VARCHAR(100) NOT NULL,
  `userId` VARCHAR(100) NOT NULL,
  `actionKey` VARCHAR(140) NOT NULL,
  `dueAt` DATETIME(3) NULL,
  PRIMARY KEY (`projectId`, `userId`, `actionKey`),
  INDEX `PersonalActionSetting_userId_idx` (`userId`),
  CONSTRAINT `PersonalActionSetting_member_fkey` FOREIGN KEY (`projectId`, `userId`) REFERENCES `ProjectMember` (`projectId`, `userId`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
