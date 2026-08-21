-- Only needed if you already have a MySQL install running the earlier
-- six-role model (super_admin, admin, team_lead, coordinator, artist,
-- creative_director) and want to keep its data. A fresh install should just
-- import sql/schema.sql, which already has the current shape.

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
