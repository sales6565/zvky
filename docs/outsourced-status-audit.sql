-- HOW MANY OUTSOURCED TASKS ARE SITTING IN A STATUS THEY SHOULD NOT BE?
--
-- Written for the CHR-002 report: "An asset in 'In Progress' cannot be marked
-- completed". I CANNOT RUN THIS. The production database (db_f8qoui5aow) is not
-- reachable from where this change was made, so the counts below have never been
-- seen -- anything reported as a production figure would be invented. Run it on
-- the GoDaddy box and the answers are yours.
--
-- IT IS READ-ONLY. Nothing here writes, and nothing needs to: the allow-list in
-- src/asset-workflow.js (OUTSOURCE_STAGE_FROM) now accepts the drifted rows, so
-- this is a diagnosis rather than a prerequisite. A rewrite of production
-- statuses is irreversible and would alter history, which is why it is not part
-- of the change.
--
-- WHAT TO EXPECT. Rows in 'not_started' are correct. Rows in 'assigned' or
-- 'in_progress' are the drift, and query 2 says whether any of them still has an
-- internal assignee, which is a different and more serious shape (see below).
-- Rows in 'tl_changes_requested' or 'cd_changes_requested' are a rework sent
-- outside and are legitimate. Anything else is worth looking at by hand.

-- 1. The headline: every live outsource assignment, by the task's status.
SELECT a.`status`,
       COUNT(*)                                                   AS assignments,
       COUNT(DISTINCT a.id)                                        AS tasks,
       SUM(a.assignee_id IS NOT NULL)                              AS also_assigned_internally,
       CASE a.`status`
         WHEN 'not_started'          THEN 'correct'
         WHEN 'assigned'             THEN 'drift - recordable, and new assignments are normalised'
         WHEN 'in_progress'          THEN 'drift - the reported case; recordable'
         WHEN 'tl_changes_requested' THEN 'rework sent outside - legitimate'
         WHEN 'cd_changes_requested' THEN 'rework sent outside - legitimate'
         WHEN 'pending_tl_review'    THEN 'delivered and waiting on a lead - expected'
         ELSE 'LOOK AT THIS ONE'
       END                                                         AS reading
  FROM assets a
  JOIN outsource_assignments oa ON oa.asset_id = a.id AND oa.status <> 'cancelled'
 GROUP BY a.`status`
 ORDER BY assignments DESC;

-- 2. THE SHAPE THAT IS NOT JUST COSMETIC: a task out with a freelancer that also
--    has somebody inside the studio on it. The exclusivity rule forbids it, so a
--    row here means the rule was bypassed at some point -- most likely a
--    freelancer unassigned, an artist given the work, and the assignment row
--    revived. Both halves of the gate refuse these, by design: the stages are
--    refused with "is assigned to somebody in the studio now", and the Outsource
--    tab offers no button. They need deciding one at a time, by a person.
SELECT a.`code`, a.`name`, a.`status`,
       u.`name`  AS internal_assignee,
       f.`name`  AS freelancer,
       oa.status AS assignment_status,
       oa.assigned_at
  FROM assets a
  JOIN outsource_assignments oa ON oa.asset_id = a.id AND oa.status <> 'cancelled'
  JOIN freelancers f ON f.id = oa.freelancer_id
  LEFT JOIN users u  ON u.id = a.assignee_id
 WHERE a.assignee_id IS NOT NULL
 ORDER BY oa.assigned_at DESC;

-- 3. THE OTHER THING WORTH KNOWING: work sessions on outsourced tasks. There
--    should be none going forward -- /start and /resume now refuse an outsourced
--    task outright, for everybody including a Super Admin -- but a task that
--    drifted to In Progress before that gate existed could be started, and an
--    OPEN one would still be ticking. Closing those is the one write worth
--    considering, and it is a decision for whoever reads this, not a side effect
--    of a deployment.
SELECT a.`code`, a.`name`, a.`status`,
       u.`name` AS worked_by,
       ws.started_at, ws.ended_at, ws.seconds,
       CASE WHEN ws.ended_at IS NULL THEN 'STILL OPEN' ELSE 'closed' END AS clock
  FROM work_sessions ws
  JOIN assets a ON a.id = ws.asset_id
  JOIN outsource_assignments oa ON oa.asset_id = a.id AND oa.status <> 'cancelled'
  LEFT JOIN users u ON u.id = ws.user_id
 ORDER BY (ws.ended_at IS NULL) DESC, ws.started_at DESC;
