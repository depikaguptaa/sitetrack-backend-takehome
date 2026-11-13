import { Router } from "express";
import { authRequired } from "../auth.js";
import { query, queryPage, transaction } from "../db.js";
import {
  asProjectNo,
  asyncRoute,
  dateString,
  pagination,
  positiveInt,
  projectAccess,
  projectPublicId,
  requiredString,
  userOf,
} from "../http.js";
import { HttpError } from "../auth.js";

export const projectsRouter = Router();
projectsRouter.use(authRequired);

const projectSorts: Record<string, string> = {
  name: "p.name ASC, p.project_no ASC",
  startDate: "p.planned_start ASC, p.project_no ASC",
  percentageDone:
    "coalesce(ta.done_count * 100.0 / nullif(ta.total_count, 0), 0) DESC, p.project_no ASC",
  lateTasks: "coalesce(la.late_count, 0) DESC, p.project_no ASC",
};

projectsRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const { limit, page, offset } = pagination(req, 100);
    const sort = typeof req.query.sort === "string" ? req.query.sort : "name";
    const order = projectSorts[sort];
    if (!order)
      throw new HttpError(
        400,
        "invalid_sort",
        "sort must be name, startDate, percentageDone, or lateTasks",
      );
    const q =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 200)
        : "";
    const onlyLate = req.query.lateOnly === "true";
    const { result, total } = await queryPage<Record<string, unknown>>(
      `WITH visible_projects AS (
       SELECT p.* FROM projects p
       LEFT JOIN project_members pm ON pm.project_no = p.project_no AND pm.user_id = $1
       WHERE p.deleted_at IS NULL AND ($2::boolean OR pm.user_id IS NOT NULL)
         AND ($3::text = '' OR p.name ILIKE '%' || $3 || '%' OR ('PRJ-' || lpad(p.project_no::text, 4, '0')) ILIKE '%' || $3 || '%')
     ), task_agg AS (
       SELECT s.project_no, s.task_count AS total_count, s.not_started_count, s.in_progress_count, s.done_count, s.blocked_count
       FROM project_task_stats s JOIN visible_projects vp ON vp.project_no = s.project_no
     ), late_agg AS (
       SELECT t.project_no, count(*) AS late_count
       FROM tasks t JOIN visible_projects vp ON vp.project_no = t.project_no
       WHERE t.deleted_at IS NULL AND t.status <> 'done'
         AND (t.planned_end < CURRENT_DATE OR (t.status = 'not_started' AND t.planned_start < CURRENT_DATE))
       GROUP BY t.project_no
     ), member_agg AS (
       SELECT project_no, count(*) AS member_count,
         bool_or(user_id = $1 AND is_admin) AS current_user_admin
       FROM project_members GROUP BY project_no
     )
     SELECT p.project_no, p.name, p.planned_start, p.planned_end,
       coalesce(ma.member_count, 0)::int AS member_count, coalesce(ma.current_user_admin, false) AS is_project_admin,
       coalesce(ta.total_count, 0)::int AS task_count,
       coalesce(ta.not_started_count, 0)::int AS not_started_count,
       coalesce(ta.in_progress_count, 0)::int AS in_progress_count,
       coalesce(ta.done_count, 0)::int AS done_count,
       coalesce(round(ta.done_count * 100.0 / nullif(ta.total_count, 0), 1), 0) AS percentage_done,
       coalesce(la.late_count, 0)::int AS late_task_count,
       coalesce(ta.blocked_count, 0)::int AS blocked_task_count,
       count(*) OVER()::int AS total_count
     FROM visible_projects p
     LEFT JOIN task_agg ta ON ta.project_no = p.project_no
     LEFT JOIN late_agg la ON la.project_no = p.project_no
     LEFT JOIN member_agg ma ON ma.project_no = p.project_no
     WHERE (NOT $4::boolean OR coalesce(la.late_count, 0) > 0)
     ORDER BY ${order} LIMIT $5 OFFSET $6`,
      [user.id, user.role === "superadmin", q, onlyLate, limit, offset],
      4,
      5,
    );
    res.json({
      items: result.rows.map((row) => ({
        id: projectPublicId(String(row.project_no)),
        name: row.name,
        plannedStart: row.planned_start,
        plannedEnd: row.planned_end,
        isProjectAdmin: row.is_project_admin,
        memberCount: row.member_count,
        taskCounts: {
          notStarted: row.not_started_count,
          inProgress: row.in_progress_count,
          done: row.done_count,
        },
        percentageDone: Number(row.percentage_done ?? 0),
        lateTaskCount: row.late_task_count,
        blockedTaskCount: row.blocked_task_count,
      })),
      page,
      limit,
      total,
    });
  }),
);

projectsRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const name = requiredString(req.body?.name, "name", 240);
    const plannedStart = dateString(req.body?.plannedStart, "plannedStart");
    const plannedEnd = dateString(req.body?.plannedEnd, "plannedEnd");
    if (plannedEnd < plannedStart)
      throw new HttpError(
        400,
        "invalid_dates",
        "plannedEnd must be on or after plannedStart",
      );
    const project = await transaction(async (client) => {
      const created = await client.query<{
        project_no: string;
        name: string;
        planned_start: string;
        planned_end: string;
      }>(
        "INSERT INTO projects(name, planned_start, planned_end, created_by) VALUES ($1, $2, $3, $4) RETURNING project_no, name, planned_start, planned_end",
        [name, plannedStart, plannedEnd, user.id],
      );
      const row = created.rows[0]!;
      await client.query(
        "INSERT INTO project_members(project_no, user_id, is_admin) VALUES ($1, $2, true)",
        [row.project_no, user.id],
      );
      return row;
    });
    res.status(201).json({
      project: {
        id: projectPublicId(project.project_no),
        name: project.name,
        plannedStart: project.planned_start,
        plannedEnd: project.planned_end,
        isProjectAdmin: true,
      },
    });
  }),
);

projectsRouter.get(
  "/:projectId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    const project = await projectAccess(projectNo, user);
    res.json({
      project: {
        id: projectPublicId(project.project_no),
        name: project.name,
        plannedStart: project.planned_start,
        plannedEnd: project.planned_end,
        isProjectAdmin: project.is_admin,
      },
    });
  }),
);

projectsRouter.patch(
  "/:projectId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user, true);
    const current = await query<{
      name: string;
      planned_start: string;
      planned_end: string;
    }>(
      "SELECT name, planned_start, planned_end FROM projects WHERE project_no = $1 AND deleted_at IS NULL",
      [projectNo],
    );
    const row = current.rows[0]!;
    const name =
      req.body?.name === undefined
        ? row.name
        : requiredString(req.body.name, "name", 240);
    const plannedStart =
      req.body?.plannedStart === undefined
        ? row.planned_start
        : dateString(req.body.plannedStart, "plannedStart");
    const plannedEnd =
      req.body?.plannedEnd === undefined
        ? row.planned_end
        : dateString(req.body.plannedEnd, "plannedEnd");
    if (plannedEnd < plannedStart)
      throw new HttpError(
        400,
        "invalid_dates",
        "plannedEnd must be on or after plannedStart",
      );
    const updated = await query<{
      project_no: string;
      name: string;
      planned_start: string;
      planned_end: string;
    }>(
      "UPDATE projects SET name = $1, planned_start = $2, planned_end = $3 WHERE project_no = $4 AND deleted_at IS NULL RETURNING project_no, name, planned_start, planned_end",
      [name, plannedStart, plannedEnd, projectNo],
    );
    res.json({
      project: {
        id: projectPublicId(updated.rows[0]!.project_no),
        name: updated.rows[0]!.name,
        plannedStart: updated.rows[0]!.planned_start,
        plannedEnd: updated.rows[0]!.planned_end,
      },
    });
  }),
);

projectsRouter.delete(
  "/:projectId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user, true);
    await query(
      "UPDATE projects SET deleted_at = now() WHERE project_no = $1 AND deleted_at IS NULL",
      [projectNo],
    );
    res.status(204).end();
  }),
);

projectsRouter.get(
  "/:projectId/members",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const { limit, page, offset } = pagination(req, 100);
    const memberPage = await queryPage<Record<string, unknown>>(
      `SELECT u.id, u.name, u.email, pm.is_admin, pm.joined_at, count(*) OVER()::int AS total_count
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_no = $1 ORDER BY u.name, u.id LIMIT $2 OFFSET $3`,
      [projectNo, limit, offset],
      1,
      2,
    );
    const members = memberPage.result;
    const invitations = await query<Record<string, unknown>>(
      `SELECT i.id, i.status, i.created_at, u.id AS user_id, u.name, u.email, inviter.name AS invited_by_name
     FROM project_invitations i JOIN users u ON u.id = i.invited_user_id JOIN users inviter ON inviter.id = i.invited_by
     WHERE i.project_no = $1 AND i.status = 'pending' ORDER BY i.created_at DESC LIMIT 100`,
      [projectNo],
    );
    res.json({
      members: members.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        isProjectAdmin: r.is_admin,
        joinedAt: r.joined_at,
      })),
      pendingInvitations: invitations.rows,
      page,
      limit,
      total: memberPage.total,
    });
  }),
);

projectsRouter.post(
  "/:projectId/invitations",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user, true, true);
    const email = requiredString(req.body?.email, "email", 320).toLowerCase();
    const invited = await query<{ id: string; name: string; email: string }>(
      "SELECT id, name, email FROM users WHERE email = $1",
      [email],
    );
    const invitedUser = invited.rows[0];
    if (!invitedUser)
      throw new HttpError(404, "not_found", "Registered user not found");
    const member = await query(
      "SELECT 1 FROM project_members WHERE project_no = $1 AND user_id = $2",
      [projectNo, invitedUser.id],
    );
    if (member.rowCount)
      throw new HttpError(
        409,
        "already_member",
        "User is already a project member",
      );
    const invitation = await transaction(async (client) => {
      const result = await client.query<{
        id: string;
        status: string;
        created_at: string;
      }>(
        "INSERT INTO project_invitations(project_no, invited_user_id, invited_by) VALUES ($1, $2, $3) RETURNING id, status, created_at",
        [projectNo, invitedUser.id, user.id],
      );
      await client.query(
        "INSERT INTO notifications(user_id, invitation_id) VALUES ($1, $2)",
        [invitedUser.id, result.rows[0]!.id],
      );
      return result.rows[0]!;
    });
    res.status(201).json({
      invitation: {
        ...invitation,
        projectId: projectPublicId(projectNo),
        invitedUser,
      },
    });
  }),
);

projectsRouter.get(
  "/:projectId/invitations",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const { limit, page, offset } = pagination(req, 100);
    const { result, total } = await queryPage<Record<string, unknown>>(
      `SELECT i.id, i.status, i.created_at, u.id AS user_id, u.name, u.email,
        inviter.name AS invited_by_name, count(*) OVER()::int AS total_count
       FROM project_invitations i
       JOIN users u ON u.id = i.invited_user_id
       JOIN users inviter ON inviter.id = i.invited_by
       WHERE i.project_no = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC, i.id DESC LIMIT $2 OFFSET $3`,
      [projectNo, limit, offset],
      1,
      2,
    );
    res.json({
      items: result.rows.map(
        ({ total_count: _count, ...invitation }) => invitation,
      ),
      page,
      limit,
      total,
    });
  }),
);

projectsRouter.delete(
  "/:projectId/invitations/:invitationId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user, true, true);
    const invitationId = positiveInt(req.params.invitationId, "invitationId");
    const result = await transaction(async (client) => {
      const update = await client.query(
        "UPDATE project_invitations SET status = 'withdrawn', answered_at = now() WHERE id = $1 AND project_no = $2 AND status = 'pending'",
        [invitationId, projectNo],
      );
      if (update.rowCount)
        await client.query(
          "UPDATE notifications SET read_at = now() WHERE invitation_id = $1",
          [invitationId],
        );
      return update;
    });
    if (!result.rowCount)
      throw new HttpError(404, "not_found", "Pending invitation not found");
    res.status(204).end();
  }),
);

projectsRouter.patch(
  "/:projectId/members/:userId/admin",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user, true, true);
    const memberId = positiveInt(req.params.userId, "userId");
    if (typeof req.body?.isAdmin !== "boolean")
      throw new HttpError(400, "invalid_body", "isAdmin must be a boolean");
    await transaction(async (client) => {
      await client.query(
        "SELECT project_no FROM projects WHERE project_no = $1 FOR UPDATE",
        [projectNo],
      );
      const target = await client.query<{ is_admin: boolean }>(
        "SELECT is_admin FROM project_members WHERE project_no = $1 AND user_id = $2 FOR UPDATE",
        [projectNo, memberId],
      );
      if (!target.rowCount)
        throw new HttpError(404, "not_found", "Project member not found");
      if (target.rows[0]!.is_admin && !req.body.isAdmin) {
        const otherAdmins = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM project_members WHERE project_no = $1 AND is_admin AND user_id <> $2",
          [projectNo, memberId],
        );
        if (Number(otherAdmins.rows[0]!.count) === 0)
          throw new HttpError(
            409,
            "last_project_admin",
            "A project must always have at least one admin",
          );
      }
      await client.query(
        "UPDATE project_members SET is_admin = $1 WHERE project_no = $2 AND user_id = $3",
        [req.body.isAdmin, projectNo, memberId],
      );
    });
    res.json({ userId: memberId, isProjectAdmin: req.body.isAdmin });
  }),
);

projectsRouter.delete(
  "/:projectId/members/:userId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user, true, true);
    const memberId = positiveInt(req.params.userId, "userId");
    await transaction(async (client) => {
      await client.query(
        "SELECT project_no FROM projects WHERE project_no = $1 FOR UPDATE",
        [projectNo],
      );
      const target = await client.query<{ is_admin: boolean }>(
        "SELECT is_admin FROM project_members WHERE project_no = $1 AND user_id = $2 FOR UPDATE",
        [projectNo, memberId],
      );
      if (!target.rowCount)
        throw new HttpError(404, "not_found", "Project member not found");
      if (target.rows[0]!.is_admin) {
        const otherAdmins = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM project_members WHERE project_no = $1 AND is_admin AND user_id <> $2",
          [projectNo, memberId],
        );
        if (Number(otherAdmins.rows[0]!.count) === 0)
          throw new HttpError(
            409,
            "last_project_admin",
            "A project must always have at least one admin",
          );
      }
      await client.query(
        "DELETE FROM project_members WHERE project_no = $1 AND user_id = $2",
        [projectNo, memberId],
      );
    });
    res.status(204).end();
  }),
);

export const notificationsRouter = Router();
notificationsRouter.use(authRequired);
notificationsRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const { limit, page, offset } = pagination(req, 100);
    const { result, total, metadataRow } = await queryPage<
      Record<string, unknown>
    >(
      `SELECT n.id AS notification_id, n.created_at, n.read_at, i.id AS invitation_id, i.status,
      p.project_no, p.name AS project_name, inviter.name AS invited_by_name,
      (SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL)::int AS unread_count,
      count(*) OVER()::int AS total_count
     FROM notifications n JOIN project_invitations i ON i.id = n.invitation_id
     JOIN projects p ON p.project_no = i.project_no JOIN users inviter ON inviter.id = i.invited_by
     WHERE n.user_id = $1 AND i.status = 'pending' AND p.deleted_at IS NULL
     ORDER BY n.created_at DESC, n.id DESC LIMIT $2 OFFSET $3`,
      [user.id, limit, offset],
      1,
      2,
    );
    res.json({
      items: result.rows.map((r) => ({
        id: r.notification_id,
        invitationId: r.invitation_id,
        projectId: projectPublicId(String(r.project_no)),
        projectName: r.project_name,
        invitedBy: r.invited_by_name,
        createdAt: r.created_at,
        unread: r.read_at === null,
      })),
      unreadCount: Number(
        result.rows[0]?.unread_count ?? metadataRow?.unread_count ?? 0,
      ),
      page,
      limit,
      total,
    });
  }),
);

notificationsRouter.post(
  "/read",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    await query(
      "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
      [user.id],
    );
    res.status(204).end();
  }),
);

notificationsRouter.post(
  "/:invitationId/respond",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const invitationId = positiveInt(req.params.invitationId, "invitationId");
    const response = req.body?.response;
    if (response !== "accept" && response !== "reject")
      throw new HttpError(
        400,
        "invalid_response",
        "response must be accept or reject",
      );
    const result = await transaction(async (client) => {
      const invitation = await client.query<{
        id: string;
        project_no: string;
        invited_user_id: string;
        status: string;
      }>(
        "SELECT id, project_no, invited_user_id, status FROM project_invitations WHERE id = $1 FOR UPDATE",
        [invitationId],
      );
      const row = invitation.rows[0];
      if (!row || row.invited_user_id !== user.id)
        throw new HttpError(404, "not_found", "Invitation not found");
      if (row.status !== "pending")
        throw new HttpError(
          409,
          "invitation_answered",
          "Invitation is no longer pending",
        );
      const status = response === "accept" ? "accepted" : "rejected";
      await client.query(
        "UPDATE project_invitations SET status = $1, answered_at = now() WHERE id = $2",
        [status, invitationId],
      );
      await client.query(
        "UPDATE notifications SET read_at = now() WHERE invitation_id = $1",
        [invitationId],
      );
      if (response === "accept")
        await client.query(
          "INSERT INTO project_members(project_no, user_id) VALUES ($1, $2)",
          [row.project_no, user.id],
        );
      return { status, projectNo: row.project_no };
    });
    res.json({
      invitationId,
      status: result.status,
      projectId: projectPublicId(result.projectNo),
    });
  }),
);
