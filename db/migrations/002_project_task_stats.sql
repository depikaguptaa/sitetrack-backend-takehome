CREATE TABLE project_task_stats (
  project_no BIGINT PRIMARY KEY REFERENCES projects(project_no) ON DELETE CASCADE,
  task_count INTEGER NOT NULL DEFAULT 0 CHECK (task_count >= 0),
  not_started_count INTEGER NOT NULL DEFAULT 0 CHECK (not_started_count >= 0),
  in_progress_count INTEGER NOT NULL DEFAULT 0 CHECK (in_progress_count >= 0),
  done_count INTEGER NOT NULL DEFAULT 0 CHECK (done_count >= 0),
  blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (task_count = not_started_count + in_progress_count + done_count)
);

CREATE FUNCTION refresh_project_task_stats(target_project_no BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  WITH task_rows AS (
    SELECT t.status,
      (t.status <> 'done' AND EXISTS (
        SELECT 1 FROM task_dependencies td JOIN tasks dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id = t.id AND dep.deleted_at IS NULL AND dep.status <> 'done'
      )) AS is_blocked
    FROM tasks t
    WHERE t.project_no = target_project_no AND t.deleted_at IS NULL
  )
  INSERT INTO project_task_stats(project_no, task_count, not_started_count, in_progress_count, done_count, blocked_count, updated_at)
  SELECT target_project_no, count(*)::int,
    count(*) FILTER (WHERE status = 'not_started')::int,
    count(*) FILTER (WHERE status = 'in_progress')::int,
    count(*) FILTER (WHERE status = 'done')::int,
    count(*) FILTER (WHERE is_blocked)::int,
    now()
  FROM task_rows
  ON CONFLICT (project_no) DO UPDATE SET
    task_count = EXCLUDED.task_count,
    not_started_count = EXCLUDED.not_started_count,
    in_progress_count = EXCLUDED.in_progress_count,
    done_count = EXCLUDED.done_count,
    blocked_count = EXCLUDED.blocked_count,
    updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION create_project_store() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stores(kind, project_no) VALUES ('project', NEW.project_no);
  INSERT INTO project_task_counters(project_no, next_task_no) VALUES (NEW.project_no, 1);
  INSERT INTO project_task_stats(project_no) VALUES (NEW.project_no);
  RETURN NEW;
END;
$$;

DO $$
DECLARE project_row RECORD;
BEGIN
  FOR project_row IN SELECT project_no FROM projects LOOP
    PERFORM refresh_project_task_stats(project_row.project_no);
  END LOOP;
END;
$$;
