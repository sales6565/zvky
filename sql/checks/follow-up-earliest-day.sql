-- THE EARLIEST DAY THE ADMIN DASHBOARD'S FOLLOW-UP LISTS CAN HONESTLY ANSWER
-- FOR, and what the picker's floor will therefore be.
--
-- READ-ONLY. Nothing here writes, locks or deletes. Safe to run on production.
--
-- WHY IT MATTERS. "People to follow up" names everybody who neither started
-- work nor filled a timesheet on a chosen day. Before the first work session
-- and the first timesheet line there is nothing recorded to clear anybody, so
-- every name in the studio appears in both lists — which reads as a
-- catastrophe rather than as an empty database. src/follow-up.js takes the
-- earlier of the two dates below and the date picker uses it as its minimum.
--
-- IST, NOT UTC. work_sessions.started_at is stored in UTC on this schema, so
-- the +330 minutes is the studio's own calendar day — the same shift the
-- section's queries apply. timesheet_entries.entry_date is already a DATE in
-- the studio's terms and takes none.
--
-- Run it as:  mysql -u <user> -p <database> < follow-up-earliest-day.sql

SELECT 'oldest work session (IST day)' AS what,
       DATE_FORMAT(DATE_ADD(MIN(started_at), INTERVAL 330 MINUTE), '%Y-%m-%d') AS day,
       COUNT(*) AS rows_in_table
  FROM work_sessions
UNION ALL
SELECT 'oldest timesheet line' AS what,
       DATE_FORMAT(MIN(entry_date), '%Y-%m-%d') AS day,
       COUNT(*) AS rows_in_table
  FROM timesheet_entries;

-- And the figure the picker will actually use: the earlier of the two.
SELECT MIN(day) AS earliest_selectable FROM (
  SELECT DATE_FORMAT(DATE_ADD(MIN(started_at), INTERVAL 330 MINUTE), '%Y-%m-%d') AS day
    FROM work_sessions
  UNION ALL
  SELECT DATE_FORMAT(MIN(entry_date), '%Y-%m-%d') AS day FROM timesheet_entries
) AS both_halves
WHERE day IS NOT NULL;

-- HOW MANY ACCOUNTS CANNOT BE PLACED IN THE PAST, which is the one gap the
-- section shows as a visible note. is_active = 0 with deactivated_at NULL is an
-- account deactivated before that column existed: there is no date to compare,
-- so they are left out of a past date rather than guessed either way.
SELECT COUNT(*) AS deactivated_with_no_date
  FROM users
 WHERE is_active = 0 AND deactivated_at IS NULL;
