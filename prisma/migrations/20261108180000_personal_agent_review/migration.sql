ALTER TABLE `AgentSubtask`
  ADD COLUMN `conversation` LONGTEXT NULL,
  ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `chatLeaseUntil` DATETIME(3) NULL;
UPDATE `AgentSubtask` SET `conversation` = '[]' WHERE `conversation` IS NULL;
ALTER TABLE `AgentSubtask` MODIFY `conversation` LONGTEXT NOT NULL;
ALTER TABLE `Project` ADD COLUMN `repositoryEnabled` BOOLEAN NOT NULL DEFAULT false;
