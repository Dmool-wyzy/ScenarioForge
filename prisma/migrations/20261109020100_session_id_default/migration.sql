-- Keep session creation compatible with deployed clients that do not know about id yet.
ALTER TABLE `AuthSession` MODIFY `id` VARCHAR(100) NOT NULL DEFAULT (UUID());
