-- Display metadata reported by the authenticated local Runner. Never used as a
-- server-side filesystem location. Existing connections/history remain unknown.
ALTER TABLE `LocalRunner` ADD COLUMN `workspaceDirectory` VARCHAR(1000) NULL;
ALTER TABLE `WorkspaceExecution` ADD COLUMN `workspaceDirectory` VARCHAR(1000) NULL;
