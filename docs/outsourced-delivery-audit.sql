-- WHAT IS AFFECTED BY RE-POINTING Mark delivered AT THE Delivered STATUS?
--
-- WRITTEN FOR A BRIEF WHOSE PREMISE NEEDS CORRECTING FIRST. "Back from
-- Freelancer" is NOT a status and never was: it is a BOARD COLUMN
-- (workflow.OUTSOURCE_DELIVERED_COLUMN, id 'outsource_delivered', deliberately
-- absent from STATE_IDS) that renders assets sitting in pending_tl_review whose
-- outsource assignment is 'delivered'. So nothing is "sitting in" it as a state;
-- what exists is rows in pending_tl_review with a delivered assignment, and
-- those are what query 1 finds.
--
-- I CANNOT RUN THIS. The production database (db_f8qoui5aow) is not reachable
-- from where this change was made, so the counts below have never been seen —
-- any production figure I quoted would be invented. Run it on the GoDaddy box.
--
-- IT IS READ-ONLY, and no migration is proposed. The rows query 1 finds are in a
-- perfectly valid state: a team lead has them to review, and they flow on
-- through the normal pipeline to Approved for Client and then Delivered. Nothing
-- is stuck. Staff who want one of them in Delivered immediately can Reopen it
-- (outsource.reopen) and Mark delivered again, which now targets Delivered — two
-- existing actions, no code change, no rewrite of history.

-- 1. The rows the old destination produced: delivered assignments whose task is
--    still waiting on a team lead. These are the ones the board used to draw in
--    the Back from Freelancer column. Grouped by project, as asked.
SELECT p.`name`                                    AS project,
       c.`name`                                    AS client,
       COUNT(*)                                    AS tasks,
       MIN(oa.delivered_at)                        AS earliest_delivery,
       MAX(oa.delivered_at)                        AS latest_delivery,
       GROUP_CONCAT(a.`code` ORDER BY a.`code` SEPARATOR ', ') AS codes
  FROM assets a
  JOIN outsource_assignments oa ON oa.asset_id = a.id AND oa.`status` = 'delivered'
  JOIN projects p ON p.id = a.project_id
  LEFT JOIN clients c ON c.id = p.client_id
 WHERE a.`status` = 'pending_tl_review'
 GROUP BY p.id, p.`name`, c.`name`
 ORDER BY tasks DESC;

-- 2. EVERY delivered assignment by the task's status, so the full picture is
--    visible rather than only the one shape above. After this change, new
--    deliveries land in 'delivered'; rows under any other status predate it.
SELECT a.`status`,
       COUNT(*) AS tasks,
       CASE a.`status`
         WHEN 'delivered'         THEN 'delivered under the new behaviour'
         WHEN 'pending_tl_review' THEN 'delivered under the old behaviour - waiting on a lead, not stuck'
         ELSE 'look at this one by hand'
       END AS reading
  FROM assets a
  JOIN outsource_assignments oa ON oa.asset_id = a.id AND oa.`status` = 'delivered'
 GROUP BY a.`status`
 ORDER BY tasks DESC;

-- 3. THE THING THE SKIPPED STAGE COSTS, so it can be judged rather than guessed:
--    tasks that will reach Delivered without a single submitted version, which
--    means without any studio review round. Expected and intended for outsourced
--    work — the studio attests it was handed over — but worth knowing the volume
--    of, because these are the rows that carry no asset_versions and therefore no
--    'deliver' event date for the Efficiency report's turnaround figure. The
--    report excludes outsourced work by name anyway (exclusionReason), so this is
--    a count, not a fault.
SELECT p.`name` AS project, a.`code`, a.`name`, a.`status`,
       f.`name` AS freelancer, oa.delivered_at,
       u.`name` AS recorded_by,
       (SELECT COUNT(*) FROM asset_versions v WHERE v.asset_id = a.id) AS submitted_versions,
       (SELECT COUNT(*) FROM work_sessions w WHERE w.asset_id = a.id)  AS work_sessions
  FROM assets a
  JOIN outsource_assignments oa ON oa.asset_id = a.id AND oa.`status` = 'delivered'
  JOIN freelancers f ON f.id = oa.freelancer_id
  JOIN projects p ON p.id = a.project_id
  LEFT JOIN users u ON u.id = oa.delivered_by
 ORDER BY oa.delivered_at DESC;
