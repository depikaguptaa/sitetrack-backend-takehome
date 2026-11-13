import { Router } from "express";
import { authRequired } from "../auth.js";
import { query, queryPage, transaction } from "../db.js";
import {
  asProjectNo,
  asyncRoute,
  dateString,
  pagination,
  projectAccess,
  requiredString,
  taskPublicId,
  userOf,
} from "../http.js";
import { HttpError } from "../auth.js";

export const tasksRouter = Router({ mergeParams: true });
tasksRouter.use(authRequired);
const taskStatuses = ["not_started", "in_progress", "done"] as const;

function parseTaskNo(value: unknown, projectNo: number): number {
  if (typeof value !== "string")
    throw new HttpError(
      400,
      "invalid_task_id",
      "taskId must use PRJ-0001-T-0001 format",
    );
  const match = /^PRJ-(\d{4,})-T-(\d{4,})$/i.exec(value);
  if (!match || Number(match[1]) !== projectNo)
    throw new HttpError(404, "not_found", "Task not found");
  const taskNo = Number(match[2]);
  if (!Number.isSafeInteger(taskNo) || taskNo < 1)
    throw new HttpError(404, "not_found", "Task not found");
  return taskNo;
}

async function findTask(projectNo: number, taskNo: number) {
  const result = await query<{
    id: string;
    project_no: string;
    task_no: number;
    name: string;
    planned_start: string;
    planned_end: string;
    status: string;
  }>(
    "SELECT id, project_no, task_no, name, planned_start, planned_end, status FROM tasks WHERE project_no = $1 AND task_no = $2 AND deleted_at IS NULL",
    [projectNo, taskNo],
  );
  const task = result.rows[0];
  if (!task) throw new HttpError(404, "not_found", "Task not found");
  return task;
}

async function dependencyState(taskId: string) {
  const result = await query<{ can_start: boolean; can_reopen: boolean }>(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1
       UNION
       SELECT td.depends_on_task_id FROM task_dependencies td JOIN ancestors a ON td.task_id = a.id
     ), dependents(id) AS (
       SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1
       UNION
       SELECT td.task_id FROM task_dependencies td JOIN dependents d ON td.depends_on_task_id = d.id
     )
     SELECT NOT EXISTS (SELECT 1 FROM ancestors a JOIN tasks t ON t.id = a.id WHERE t.deleted_at IS NULL AND t.status <> 'done') AS can_start,
       NOT EXISTS (SELECT 1 FROM dependents d JOIN tasks t ON t.id = d.id WHERE t.deleted_at IS NULL AND t.status <> 'not_started') AS can_reopen`,
    [taskId],
  );
  return result.rows[0]!;
}

type DependencyEdge = {
  relationship: "ancestor" | "dependent";
  source_id: string;
  neighbor_id: string;
  task_no: number;
  name: string;
};

function shortestDependencyPaths(
  rootId: string,
  edges: DependencyEdge[],
  relationship: DependencyEdge["relationship"],
) {
  const adjacency = new Map<string, string[]>();
  const tasks = new Map<string, { task_no: number; name: string }>();
  for (const edge of edges) {
    if (edge.relationship !== relationship) continue;
    const neighbors = adjacency.get(edge.source_id) ?? [];
    neighbors.push(edge.neighbor_id);
    adjacency.set(edge.source_id, neighbors);
    tasks.set(edge.neighbor_id, { task_no: edge.task_no, name: edge.name });
  }

  const distances = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentId = queue[cursor]!;
    const nextDistance = distances.get(currentId)! + 1;
    for (const neighborId of adjacency.get(currentId) ?? []) {
      if (distances.has(neighborId)) continue;
      distances.set(neighborId, nextDistance);
      queue.push(neighborId);
    }
  }

  return [...distances]
    .filter(([id]) => id !== rootId)
    .map(([id, stepsAway]) => ({ id, ...tasks.get(id)!, stepsAway }))
    .sort((a, b) => a.stepsAway - b.stepsAway || a.task_no - b.task_no);
}

const taskSorts: Record<string, string> = {
  id: "t.task_no ASC",
  name: "t.name ASC, t.task_no ASC",
  startDate: "t.planned_start ASC, t.task_no ASC",
  endDate: "t.planned_end ASC, t.task_no ASC",
  dependentCount: "dependent_count DESC, t.task_no ASC",
};

tasksRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const { limit, page, offset } = pagination(req, 100);
    const sort = typeof req.query.sort === "string" ? req.query.sort : "id";
    const order = taskSorts[sort];
    if (!order)
      throw new HttpError(
        400,
        "invalid_sort",
        "sort must be id, name, startDate, endDate, or dependentCount",
      );
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 200)
        : "";
    const status =
      req.query.status === undefined ? null : String(req.query.status);
    if (
      status !== null &&
      !(taskStatuses as readonly string[]).includes(status)
    )
      throw new HttpError(
        400,
        "invalid_status",
        "status must be not_started, in_progress, or done",
      );
    const late =
      req.query.late === undefined ? null : req.query.late === "true";
    const blocked =
      req.query.blocked === undefined ? null : req.query.blocked === "true";
    if (
      req.query.late !== undefined &&
      req.query.late !== "true" &&
      req.query.late !== "false"
    )
      throw new HttpError(400, "invalid_filter", "late must be true or false");
    if (
      req.query.blocked !== undefined &&
      req.query.blocked !== "true" &&
      req.query.blocked !== "false"
    )
      throw new HttpError(
        400,
        "invalid_filter",
        "blocked must be true or false",
      );
    const dateFrom =
      req.query.dateFrom === undefined
        ? null
        : dateString(req.query.dateFrom, "dateFrom");
    const dateTo =
      req.query.dateTo === undefined
        ? null
        : dateString(req.query.dateTo, "dateTo");
    if (dateFrom && dateTo && dateFrom > dateTo)
      throw new HttpError(
        400,
        "invalid_dates",
        "dateFrom must be on or before dateTo",
      );
    const { result, total } = await queryPage<Record<string, unknown>>(
      `WITH task_rows AS (
       SELECT t.id, t.project_no, t.task_no, t.name, t.planned_start, t.planned_end, t.status,
         (t.status <> 'done' AND (t.planned_end < CURRENT_DATE OR (t.status = 'not_started' AND t.planned_start < CURRENT_DATE))) AS is_late,
         (t.status <> 'done' AND EXISTS (
           SELECT 1 FROM task_dependencies td JOIN tasks dep ON dep.id = td.depends_on_task_id
           WHERE td.task_id = t.id AND dep.deleted_at IS NULL AND dep.status <> 'done'
         )) AS is_blocked,
         (SELECT count(*)::int FROM task_dependencies td WHERE td.depends_on_task_id = t.id) AS dependent_count,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', 'PRJ-' || lpad(t.project_no::text, 4, '0') || '-T-' || lpad(dep.task_no::text, 4, '0'),
           'name', dep.name
         ) ORDER BY dep.task_no), '[]'::jsonb)
          FROM task_dependencies td JOIN tasks dep ON dep.id = td.depends_on_task_id AND dep.deleted_at IS NULL
          WHERE td.task_id = t.id) AS depends_on
       FROM tasks t
       WHERE t.project_no = $1 AND t.deleted_at IS NULL
         AND ($2::text = '' OR t.name ILIKE '%' || $2 || '%' OR ('PRJ-' || lpad(t.project_no::text, 4, '0') || '-T-' || lpad(t.task_no::text, 4, '0')) ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR t.status = $3::task_status)
         AND ($4::boolean IS NULL OR (t.status <> 'done' AND (t.planned_end < CURRENT_DATE OR (t.status = 'not_started' AND t.planned_start < CURRENT_DATE))) = $4)
         AND ($5::boolean IS NULL OR (t.status <> 'done' AND EXISTS (
           SELECT 1 FROM task_dependencies td JOIN tasks dep ON dep.id = td.depends_on_task_id
           WHERE td.task_id = t.id AND dep.deleted_at IS NULL AND dep.status <> 'done'
         )) = $5)
         AND ($6::date IS NULL OR t.planned_end >= $6)
         AND ($7::date IS NULL OR t.planned_start <= $7)
     )
     SELECT *, count(*) OVER()::int AS total_count FROM task_rows t
     ORDER BY ${order} LIMIT $8 OFFSET $9`,
      [
        projectNo,
        search,
        status,
        late,
        blocked,
        dateFrom,
        dateTo,
        limit,
        offset,
      ],
      7,
      8,
    );
    res.json({
      items: result.rows.map((r) => ({
        id: taskPublicId(String(r.project_no), String(r.task_no)),
        name: r.name,
        plannedStart: r.planned_start,
        plannedEnd: r.planned_end,
        status: r.status,
        late: r.is_late,
        blocked: r.is_blocked,
        dependsOn: r.depends_on,
        dependentCount: r.dependent_count,
      })),
      page,
      limit,
      total,
    });
  }),
);

tasksRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const name = requiredString(req.body?.name, "name", 240);
    const plannedStart = dateString(req.body?.plannedStart, "plannedStart");
    const plannedEnd = dateString(req.body?.plannedEnd, "plannedEnd");
    if (plannedEnd < plannedStart)
      throw new HttpError(
        400,
        "invalid_dates",
        "plannedEnd must be on or after plannedStart",
      );
    const task = await transaction(async (client) => {
      const counter = await client.query<{ task_no: number }>(
        "UPDATE project_task_counters SET next_task_no = next_task_no + 1 WHERE project_no = $1 RETURNING next_task_no - 1 AS task_no",
        [projectNo],
      );
      if (!counter.rowCount)
        throw new HttpError(404, "not_found", "Project not found");
      const result = await client.query<{
        id: string;
        task_no: number;
        name: string;
        planned_start: string;
        planned_end: string;
      }>(
        "INSERT INTO tasks(project_no, task_no, name, planned_start, planned_end, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, task_no, name, planned_start, planned_end",
        [
          projectNo,
          counter.rows[0]!.task_no,
          name,
          plannedStart,
          plannedEnd,
          user.id,
        ],
      );
      await client.query("SELECT refresh_project_task_stats($1)", [projectNo]);
      return result.rows[0]!;
    });
    res.status(201).json({
      task: {
        id: taskPublicId(projectNo, task.task_no),
        name: task.name,
        plannedStart: task.planned_start,
        plannedEnd: task.planned_end,
        status: "not_started",
        late: false,
        blocked: false,
      },
    });
  }),
);

tasksRouter.get(
  "/:taskId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const taskNo = parseTaskNo(req.params.taskId, projectNo);
    const task = await findTask(projectNo, taskNo);
    const [state, edges] = await Promise.all([
      dependencyState(task.id),
      query<Record<string, unknown>>(
        `WITH RECURSIVE ancestors(id) AS (
         SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1
         UNION
         SELECT td.depends_on_task_id FROM task_dependencies td JOIN ancestors a ON td.task_id = a.id
       ), dependents(id) AS (
         SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1
         UNION
         SELECT td.task_id FROM task_dependencies td JOIN dependents d ON td.depends_on_task_id = d.id
       ), ancestor_sources(id) AS (
         SELECT $1::bigint UNION SELECT id FROM ancestors
       ), dependent_sources(id) AS (
         SELECT $1::bigint UNION SELECT id FROM dependents
       )
       SELECT 'ancestor' AS relationship, td.task_id AS source_id, td.depends_on_task_id AS neighbor_id, t.task_no, t.name
       FROM ancestor_sources source JOIN task_dependencies td ON td.task_id = source.id
       JOIN tasks t ON t.id = td.depends_on_task_id AND t.deleted_at IS NULL
       UNION ALL
       SELECT 'dependent' AS relationship, td.depends_on_task_id AS source_id, td.task_id AS neighbor_id, t.task_no, t.name
       FROM dependent_sources source JOIN task_dependencies td ON td.depends_on_task_id = source.id
       JOIN tasks t ON t.id = td.task_id AND t.deleted_at IS NULL`,
        [task.id],
      ),
    ]);
    const dependencyEdges = edges.rows as unknown as DependencyEdge[];
    const ancestors = shortestDependencyPaths(
      task.id,
      dependencyEdges,
      "ancestor",
    ).map((task) => ({
      id: taskPublicId(projectNo, String(task.task_no)),
      name: task.name,
      stepsAway: task.stepsAway,
    }));
    const dependents = shortestDependencyPaths(
      task.id,
      dependencyEdges,
      "dependent",
    ).map((task) => ({
      id: taskPublicId(projectNo, String(task.task_no)),
      name: task.name,
      stepsAway: task.stepsAway,
    }));
    const late =
      task.status !== "done" &&
      (task.planned_end < new Date().toISOString().slice(0, 10) ||
        (task.status === "not_started" &&
          task.planned_start < new Date().toISOString().slice(0, 10)));
    const blocked = task.status !== "done" && !state.can_start;
    res.json({
      task: {
        id: taskPublicId(projectNo, task.task_no),
        name: task.name,
        plannedStart: task.planned_start,
        plannedEnd: task.planned_end,
        status: task.status,
        late,
        blocked,
      },
      allowedActions: {
        start: task.status === "not_started" && state.can_start,
        markDone: task.status === "in_progress",
        reopen: task.status === "done" && state.can_reopen,
      },
      waitsOn: ancestors,
      waitedOnBy: dependents,
    });
  }),
);

tasksRouter.patch(
  "/:taskId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const taskNo = parseTaskNo(req.params.taskId, projectNo);
    if (req.body?.status !== undefined)
      throw new HttpError(
        400,
        "invalid_status_change",
        "Use the start, done, or reopen action endpoint to change status",
      );
    const current = await findTask(projectNo, taskNo);
    const name =
      req.body?.name === undefined
        ? current.name
        : requiredString(req.body.name, "name", 240);
    const plannedStart =
      req.body?.plannedStart === undefined
        ? current.planned_start
        : dateString(req.body.plannedStart, "plannedStart");
    const plannedEnd =
      req.body?.plannedEnd === undefined
        ? current.planned_end
        : dateString(req.body.plannedEnd, "plannedEnd");
    if (plannedEnd < plannedStart)
      throw new HttpError(
        400,
        "invalid_dates",
        "plannedEnd must be on or after plannedStart",
      );
    await query(
      "UPDATE tasks SET name = $1, planned_start = $2, planned_end = $3 WHERE id = $4",
      [name, plannedStart, plannedEnd, current.id],
    );
    res.json({
      task: {
        id: taskPublicId(projectNo, taskNo),
        name,
        plannedStart,
        plannedEnd,
        status: current.status,
      },
    });
  }),
);

tasksRouter.delete(
  "/:taskId",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const taskNo = parseTaskNo(req.params.taskId, projectNo);
    const task = await findTask(projectNo, taskNo);
    await transaction(async (client) => {
      await client.query(
        "SELECT project_no FROM projects WHERE project_no = $1 FOR UPDATE",
        [projectNo],
      );
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [
        task.id,
      ]);
      await client.query(
        "DELETE FROM task_dependencies WHERE task_id = $1 OR depends_on_task_id = $1",
        [task.id],
      );
      await client.query("UPDATE tasks SET deleted_at = now() WHERE id = $1", [
        task.id,
      ]);
      await client.query("SELECT refresh_project_task_stats($1)", [projectNo]);
    });
    res.status(204).end();
  }),
);

tasksRouter.put(
  "/:taskId/dependencies",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const taskNo = parseTaskNo(req.params.taskId, projectNo);
    const task = await findTask(projectNo, taskNo);
    if (!Array.isArray(req.body?.dependsOn) || req.body.dependsOn.length > 3000)
      throw new HttpError(
        400,
        "invalid_dependencies",
        "dependsOn must be an array of at most 3,000 task IDs",
      );
    const dependencyNos = [
      ...new Set(
        (req.body.dependsOn as unknown[]).map((id) =>
          parseTaskNo(id, projectNo),
        ),
      ),
    ];
    if (dependencyNos.includes(taskNo))
      throw new HttpError(
        400,
        "dependency_cycle",
        "A task cannot depend on itself",
      );
    const saved = await transaction(async (client) => {
      await client.query(
        "SELECT project_no FROM projects WHERE project_no = $1 FOR UPDATE",
        [projectNo],
      );
      const current = await client.query<{ status: string }>(
        "SELECT status FROM tasks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [task.id],
      );
      if (!current.rowCount)
        throw new HttpError(404, "not_found", "Task not found");
      if (current.rows[0]!.status !== "not_started")
        throw new HttpError(
          409,
          "dependencies_locked",
          "Dependencies can only change before a task starts",
        );
      const candidates = await client.query<{ id: string; task_no: number }>(
        "SELECT id, task_no FROM tasks WHERE project_no = $1 AND task_no = ANY($2::int[]) AND deleted_at IS NULL",
        [projectNo, dependencyNos],
      );
      if (candidates.rowCount !== dependencyNos.length)
        throw new HttpError(
          404,
          "not_found",
          "One or more dependency tasks were not found",
        );
      await client.query("DELETE FROM task_dependencies WHERE task_id = $1", [
        task.id,
      ]);
      for (const candidate of candidates.rows) {
        const cycle = await client.query(
          `WITH RECURSIVE reachable(id) AS (
           SELECT $2::bigint UNION SELECT td.depends_on_task_id FROM task_dependencies td JOIN reachable r ON td.task_id = r.id
         ) SELECT 1 FROM reachable WHERE id = $1 LIMIT 1`,
          [task.id, candidate.id],
        );
        if (cycle.rowCount)
          throw new HttpError(
            400,
            "dependency_cycle",
            "This dependency would create a cycle",
          );
        await client.query(
          "INSERT INTO task_dependencies(project_no, task_id, depends_on_task_id) VALUES ($1, $2, $3)",
          [projectNo, task.id, candidate.id],
        );
      }
      await client.query("SELECT refresh_project_task_stats($1)", [projectNo]);
      return candidates.rows.map((r) => taskPublicId(projectNo, r.task_no));
    });
    res.json({ taskId: taskPublicId(projectNo, taskNo), dependsOn: saved });
  }),
);

tasksRouter.post(
  "/:taskId/actions/:action",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const taskNo = parseTaskNo(req.params.taskId, projectNo);
    const action = req.params.action;
    if (action !== "start" && action !== "done" && action !== "reopen")
      throw new HttpError(404, "not_found", "Action not found");
    const task = await findTask(projectNo, taskNo);
    const nextStatus =
      action === "start" || action === "reopen" ? "in_progress" : "done";
    const updated = await transaction(async (client) => {
      await client.query(
        "SELECT project_no FROM projects WHERE project_no = $1 FOR UPDATE",
        [projectNo],
      );
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [
        task.id,
      ]);
      const fresh = await client.query<{ status: string }>(
        "SELECT status FROM tasks WHERE id = $1 AND deleted_at IS NULL",
        [task.id],
      );
      const state = await client.query<{
        can_start: boolean;
        can_reopen: boolean;
      }>(
        `WITH RECURSIVE ancestors(id) AS (
         SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1
         UNION SELECT td.depends_on_task_id FROM task_dependencies td JOIN ancestors a ON td.task_id = a.id
       ), dependents(id) AS (
         SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1
         UNION SELECT td.task_id FROM task_dependencies td JOIN dependents d ON td.depends_on_task_id = d.id
       )
       SELECT NOT EXISTS (SELECT 1 FROM ancestors a JOIN tasks t ON t.id = a.id WHERE t.deleted_at IS NULL AND t.status <> 'done') AS can_start,
         NOT EXISTS (SELECT 1 FROM dependents d JOIN tasks t ON t.id = d.id WHERE t.deleted_at IS NULL AND t.status <> 'not_started') AS can_reopen`,
        [task.id],
      );
      const status = fresh.rows[0]?.status;
      if (
        action === "start" &&
        (status !== "not_started" || !state.rows[0]!.can_start)
      )
        throw new HttpError(
          409,
          "action_not_allowed",
          "Task can start only when it is not started and all dependencies are done",
        );
      if (action === "done" && status !== "in_progress")
        throw new HttpError(
          409,
          "action_not_allowed",
          "Only an in-progress task can be marked done",
        );
      if (
        action === "reopen" &&
        (status !== "done" || !state.rows[0]!.can_reopen)
      )
        throw new HttpError(
          409,
          "action_not_allowed",
          "A done task can reopen only when no dependent task has started",
        );
      const result = await client.query<{ status: string }>(
        "UPDATE tasks SET status = $1 WHERE id = $2 RETURNING status",
        [nextStatus, task.id],
      );
      await client.query("SELECT refresh_project_task_stats($1)", [projectNo]);
      return result;
    });
    res.json({
      taskId: taskPublicId(projectNo, taskNo),
      status: updated.rows[0]!.status,
    });
  }),
);
