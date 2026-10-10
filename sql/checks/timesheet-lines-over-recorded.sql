-- Timesheet lines that claim more than the person recorded on that asset that day.
--
-- WHY THIS EXISTS. Until this change a line naming an asset was worth the
-- asset's whole recorded time for that person less everything they had ever
-- filed against it, so a day could be filed with hours that were worked on
-- another day — and the next day's line was then refused as already claimed.
-- Lines already saved are NOT rewritten by the change. This finds the ones that
-- look affected, so a correction can be decided on evidence.
--
-- READ-ONLY. There is no UPDATE in this file and there should not be one: the
-- hours on a filed line are somebody's own record of their day, and the pay and
-- utilisation figures already drawn from them. A correction is a separate,
-- reviewable migration — see the note in README.
--
-- IT IS A FINDER, NOT THE EXACT FIGURE. A session that ran past midnight is
-- counted here entirely under its START date, because the honest split needs
-- the studio's open-hours arithmetic (workingMsByDay in src/working-time.js)
-- and that cannot be expressed in one statement. So a line may appear here that
-- a split would clear, and `crossing_sessions` says when that is possible.
-- 330 minutes is IST, the studio's own day boundary.
SELECT e.id,
       e.user_id,
       u.email,
       e.entry_date,
       e.asset_id,
       a.code                                        AS asset_code,
       e.hours                                       AS filed_hours,
       ROUND(COALESCE(w.secs, 0) / 3600, 2)          AS recorded_that_day,
       ROUND(e.hours - COALESCE(w.secs, 0) / 3600, 2) AS excess_hours,
       COALESCE(w.crossing, 0)                       AS crossing_sessions,
       d.status                                      AS day_status
  FROM timesheet_entries e
  LEFT JOIN users  u ON u.id = e.user_id
  LEFT JOIN assets a ON a.id = e.asset_id
  LEFT JOIN timesheet_days d ON d.user_id = e.user_id AND d.work_date = e.entry_date
  LEFT JOIN (
        SELECT user_id,
               asset_id,
               DATE(started_at + INTERVAL 330 MINUTE) AS ist_day,
               SUM(COALESCE(seconds, 0))              AS secs,
               SUM(DATE(started_at + INTERVAL 330 MINUTE)
                   <> DATE(COALESCE(ended_at, NOW()) + INTERVAL 330 MINUTE)) AS crossing
          FROM work_sessions
         GROUP BY user_id, asset_id, ist_day
       ) w
    ON w.user_id = e.user_id AND w.asset_id = e.asset_id AND w.ist_day = e.entry_date
 WHERE e.asset_id IS NOT NULL
   -- A hundredth of an hour of slack: the stored figure is rounded to two
   -- places, and a line matching its day to the second must not be flagged.
   AND e.hours > ROUND(COALESCE(w.secs, 0) / 3600, 2) + 0.01
 ORDER BY e.entry_date, u.email;
