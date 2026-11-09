ALTER TABLE `ProjectMember`
    ADD COLUMN `personalAgentConfigEncrypted` LONGTEXT NULL,
    ADD COLUMN `acceptsAgentTasks` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `AgentSubtask`
    ADD COLUMN `assigneeId` VARCHAR(100) NULL,
    ADD COLUMN `assigneeName` VARCHAR(64) NULL,
    ADD INDEX `AgentSubtask_assignee_created_idx`(`assigneeId`, `createdAt`);
