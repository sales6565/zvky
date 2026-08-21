-- Only needed if you already have a MySQL install running the earlier
-- six-role model (super_admin, admin, team_lead, coordinator, artist,
-- creative_director) and want to keep its data. A fresh install should just
-- import sql/schema.sql, which already has the current shape.

-- The app applies all of this automatically at startup (src/migrate.js), so you
-- only need this file if you would rather run it yourself.

-- The old schema constrained users.role to the six roles that existed then, so
-- inserting any of the current designations fails with
-- ER_CHECK_CONSTRAINT_VIOLATED. Drop it — roles are validated by src/roles.js.
-- The constraint is usually auto-named users_chk_1; confirm yours with
--   SHOW CREATE TABLE users;
-- MySQL 8 uses DROP CHECK, MariaDB uses DROP CONSTRAINT.
ALTER TABLE users DROP CHECK users_chk_1;
-- ALTER TABLE users DROP CONSTRAINT users_chk_1;   -- MariaDB

START TRANSACTION;

-- The role column used to be narrower; the designation keys are longer.
ALTER TABLE users MODIFY `role` VARCHAR(64) NOT NULL;

-- Creative direction is now held by the Art Director.
UPDATE users SET `role` = 'art_director' WHERE `role` = 'creative_director';

-- Everyone previously recorded as a generic 'artist' becomes a Game Artist.
-- There is no way to recover their real designation from the old data, so
-- reassign them individually in the Users tab afterwards — or, if you know the
-- mapping, run targeted updates before this line, e.g.
--   UPDATE users SET `role` = 'senior_game_animator' WHERE email IN ('...');
UPDATE users SET `role` = 'game_artist' WHERE `role` = 'artist';

-- 'super_admin', 'admin', 'coordinator' and 'team_lead' keep their keys.

CREATE INDEX idx_users_role ON users (`role`);

COMMIT;
