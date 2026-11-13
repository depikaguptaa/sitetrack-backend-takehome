CREATE INDEX task_dependencies_dependent_idx
  ON task_dependencies(depends_on_task_id, task_id);
