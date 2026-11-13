import { hashPassword } from "../src/auth.js";
import { pool } from "../src/db.js";

async function seed() {
  const client = await pool.connect();
  try {
    const existing = await client.query<{ count: string }>(
      "SELECT (SELECT count(*) FROM users) AS count",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0)
      throw new Error(
        "Refusing to seed a non-empty database. Use a fresh Docker volume or reset it explicitly.",
      );
    const passwordHash = await hashPassword("SiteTrackDemo123!");
    await client.query("BEGIN");
    await client.query("SET LOCAL synchronous_commit = OFF");
    await client.query("SET LOCAL statement_timeout = '20min'");
    console.info("creating 5,000 demo users");
    await client.query(
      `INSERT INTO users(id, name, email, password_hash, role) OVERRIDING SYSTEM VALUE
       SELECT n, CASE n WHEN 1 THEN 'Demo SuperAdmin' WHEN 2 THEN 'Demo Store Manager' ELSE 'Demo User ' || lpad(n::text, 4, '0') END,
         'user' || lpad(n::text, 4, '0') || '@sitetrack.example', $1,
         CASE n WHEN 1 THEN 'superadmin'::app_role WHEN 2 THEN 'company_store_manager'::app_role ELSE 'user'::app_role END
       FROM generate_series(1, 5000) n`,
      [passwordHash],
    );
    await client.query(
      "SELECT setval(pg_get_serial_sequence('users', 'id'), 5000, true)",
    );
    console.info("creating 2,000 projects, memberships and invitations");
    await client.query(
      `INSERT INTO projects(project_no, name, planned_start, planned_end, created_by) OVERRIDING SYSTEM VALUE
       SELECT n, 'Construction Project ' || lpad(n::text, 4, '0'), CURRENT_DATE - ((n * 7) % 720), CURRENT_DATE + (180 - ((n * 7) % 720)), 1
       FROM generate_series(1, 2000) n`,
    );
    await client.query(
      "SELECT setval(pg_get_serial_sequence('projects', 'project_no'), 2000, true)",
    );
    await client.query(
      `INSERT INTO project_members(project_no, user_id, is_admin, joined_at)
       SELECT p.project_no, 2 + ((p.project_no * 50 + member_no) % 4999), member_no = 0, now() - ((p.project_no + member_no) % 900) * interval '1 day'
       FROM projects p CROSS JOIN LATERAL generate_series(0, 10 + ((p.project_no * 13) % 41) - 1) member_no`,
    );
    await client.query(
      `INSERT INTO project_invitations(project_no, invited_user_id, invited_by, status, created_at)
       SELECT p.project_no, 2 + ((p.project_no * 50 + invite_no) % 4999), 2 + ((p.project_no * 50) % 4999), 'pending', now() - ((p.project_no + invite_no) % 180) * interval '1 day'
       FROM projects p CROSS JOIN generate_series(60, 84) invite_no`,
    );
    await client.query(
      "INSERT INTO notifications(user_id, invitation_id, created_at) SELECT invited_user_id, id, created_at FROM project_invitations",
    );
    console.info("creating 500,000 tasks and 1,000,000 dependency edges");
    await client.query(
      `INSERT INTO tasks(project_no, task_no, name, planned_start, planned_end, status, created_by)
       SELECT p.project_no, task_no, 'Work package ' || lpad(task_no::text, 4, '0'),
         CURRENT_DATE + (task_no - 130), CURRENT_DATE + (task_no - 116),
         CASE WHEN task_no <= 100 THEN 'done'::task_status WHEN task_no = 101 THEN 'in_progress'::task_status ELSE 'not_started'::task_status END,
         2 + ((p.project_no * 50) % 4999)
       FROM projects p CROSS JOIN LATERAL generate_series(1,
         CASE WHEN p.project_no = 1 THEN 3000 WHEN p.project_no <= 1249 THEN 249 ELSE 248 END) task_no`,
    );
    await client.query(
      "UPDATE project_task_counters c SET next_task_no = t.max_task_no + 1 FROM (SELECT project_no, max(task_no) AS max_task_no FROM tasks GROUP BY project_no) t WHERE t.project_no = c.project_no",
    );
    await client.query(
      `INSERT INTO task_dependencies(project_no, task_id, depends_on_task_id)
       SELECT t.project_no, t.id, predecessor.id FROM tasks t JOIN tasks predecessor ON predecessor.project_no = t.project_no AND predecessor.task_no = t.task_no - 1 WHERE t.task_no > 1`,
    );
    await client.query(
      `INSERT INTO task_dependencies(project_no, task_id, depends_on_task_id)
       SELECT t.project_no, t.id, predecessor.id FROM tasks t JOIN tasks predecessor ON predecessor.project_no = t.project_no AND predecessor.task_no = t.task_no - 2 WHERE t.task_no > 2`,
    );
    await client.query(
      `INSERT INTO task_dependencies(project_no, task_id, depends_on_task_id)
       SELECT t.project_no, t.id, predecessor.id FROM tasks t JOIN tasks predecessor ON predecessor.project_no = t.project_no AND predecessor.task_no = t.task_no - 3 WHERE t.task_no BETWEEN 4 AND 6`,
    );
    await client.query(
      "SELECT refresh_project_task_stats(project_no) FROM projects",
    );
    console.info(
      "creating 20,000 materials and 400,000 deliveries with 3,000,000 lines",
    );
    await client.query(
      `INSERT INTO materials(id, name, category, unit) OVERRIDING SYSTEM VALUE
       SELECT n, CASE n % 8 WHEN 0 THEN 'OPC Cement ' WHEN 1 THEN 'Washed Sand ' WHEN 2 THEN 'Rebar ' WHEN 3 THEN 'Crushed Aggregate ' WHEN 4 THEN 'Electrical Cable ' WHEN 5 THEN 'PVC Pipe ' WHEN 6 THEN 'Ceramic Tile ' ELSE 'Waterproofing Compound ' END || lpad(n::text, 5, '0'),
         CASE n % 8 WHEN 0 THEN 'Cement' WHEN 1 THEN 'Aggregate' WHEN 2 THEN 'Steel' WHEN 3 THEN 'Aggregate' WHEN 4 THEN 'Electrical' WHEN 5 THEN 'Plumbing' WHEN 6 THEN 'Finishes' ELSE 'Chemicals' END,
         CASE n % 4 WHEN 0 THEN 'bag' WHEN 1 THEN 'kg' WHEN 2 THEN 'm' ELSE 'piece' END
       FROM generate_series(1, 20000) n`,
    );
    await client.query(
      "SELECT setval(pg_get_serial_sequence('materials', 'id'), 20000, true)",
    );
    await client.query(
      `INSERT INTO deliveries(id, source_store_id, destination_store_id, status, sent_by, received_by, sent_at, received_at)
       OVERRIDING SYSTEM VALUE
       SELECT g.delivery_no,
         CASE WHEN g.delivery_no <= 360000 THEN company.id ELSE project_store.id END,
         CASE WHEN g.delivery_no <= 360000 THEN project_store.id ELSE company.id END,
         CASE g.delivery_no % 10 WHEN 0 THEN 'in_transit'::delivery_status WHEN 7 THEN 'rejected'::delivery_status WHEN 8 THEN 'cancelled'::delivery_status ELSE 'delivered'::delivery_status END,
         CASE WHEN g.delivery_no <= 360000 THEN 2 ELSE admin.user_id END,
         CASE WHEN g.delivery_no % 10 IN (0, 8) THEN NULL WHEN g.delivery_no <= 360000 THEN admin.user_id ELSE 2 END,
         now() - ((g.delivery_no * 13) % 1825) * interval '1 day',
         CASE WHEN g.delivery_no % 10 = 0 THEN NULL ELSE now() - ((g.delivery_no * 13) % 1825) * interval '1 day' + ((g.delivery_no % 10) + 1) * interval '1 day' END
       FROM generate_series(1, 400000) g(delivery_no)
       JOIN projects p ON p.project_no = ((g.delivery_no - 1) % 2000) + 1
       JOIN stores company ON company.kind = 'company'
       JOIN stores project_store ON project_store.kind = 'project' AND project_store.project_no = p.project_no
       JOIN project_members admin ON admin.project_no = p.project_no AND admin.is_admin`,
    );
    await client.query(
      `INSERT INTO delivery_lines(delivery_id, material_id, quantity)
       SELECT d.id, ((p.project_no * 31 + line_no * 97 - 1) % 20000) + 1,
         CASE WHEN d.source_store_id = company.id THEN 1.000::numeric ELSE 0.250::numeric END
       FROM deliveries d
       JOIN stores company ON company.kind = 'company' AND (company.id = d.source_store_id OR company.id = d.destination_store_id)
       JOIN stores project_store ON project_store.id = CASE WHEN d.source_store_id = company.id THEN d.destination_store_id ELSE d.source_store_id END
       JOIN projects p ON p.project_no = project_store.project_no
       CROSS JOIN LATERAL generate_series(1, CASE WHEN d.id % 2 = 0 THEN 7 ELSE 8 END) line_no`,
    );
    const companyStore = await client.query<{ id: string }>(
      "SELECT id FROM stores WHERE kind = 'company'",
    );
    const companyId = companyStore.rows[0]!.id;
    await client.query(
      `INSERT INTO stock_balances(store_id, material_id, quantity, reorder_point, updated_at, last_delivery_at)
       SELECT $1, m.id,
         100000::numeric
           - coalesce(sum(dl.quantity) FILTER (WHERE d.source_store_id = $1 AND d.status IN ('delivered', 'in_transit')), 0)
           + coalesce(sum(dl.quantity) FILTER (WHERE d.destination_store_id = $1 AND d.status = 'delivered'), 0),
         CASE WHEN m.id % 5 = 0 THEN 0 ELSE 20 + (m.id % 80) END,
         now(), max(d.received_at)
       FROM materials m LEFT JOIN delivery_lines dl ON dl.material_id = m.id LEFT JOIN deliveries d ON d.id = dl.delivery_id
       GROUP BY m.id`,
      [companyId],
    );
    await client.query(
      `INSERT INTO stock_balances(store_id, material_id, quantity, reorder_point, updated_at, last_delivery_at)
       SELECT s.id, dl.material_id,
         sum(dl.quantity) FILTER (WHERE d.destination_store_id = s.id AND d.status = 'delivered')
         - sum(dl.quantity) FILTER (WHERE d.source_store_id = s.id AND d.status IN ('delivered', 'in_transit')),
         0, now(), max(CASE WHEN d.destination_store_id = s.id THEN d.received_at ELSE d.sent_at END)
       FROM stores s JOIN deliveries d ON d.source_store_id = s.id OR d.destination_store_id = s.id
       JOIN delivery_lines dl ON dl.delivery_id = d.id
       WHERE s.kind = 'project'
       GROUP BY s.id, dl.material_id
       HAVING sum(dl.quantity) FILTER (WHERE d.destination_store_id = s.id AND d.status = 'delivered')
         > sum(dl.quantity) FILTER (WHERE d.source_store_id = s.id AND d.status IN ('delivered', 'in_transit'))`,
    );
    await client.query(
      "SELECT setval(pg_get_serial_sequence('deliveries', 'id'), (SELECT max(id) FROM deliveries), true)",
    );
    await client.query(
      "ANALYZE users, projects, project_members, project_invitations, tasks, task_dependencies, project_task_stats, materials, deliveries, delivery_lines, stock_balances",
    );
    await client.query("COMMIT");
    const counts = await client.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM projects) AS projects,
         (SELECT count(*) FROM project_invitations) AS invitations, (SELECT count(*) FROM tasks) AS tasks,
         (SELECT count(*) FROM task_dependencies) AS dependencies, (SELECT count(*) FROM materials) AS materials,
         (SELECT count(*) FROM deliveries) AS deliveries, (SELECT count(*) FROM delivery_lines) AS delivery_lines`,
    );
    console.info("seed complete", counts.rows[0]);
    console.info(
      "Demo accounts: user0001@sitetrack.example / user0002@sitetrack.example / user0003@sitetrack.example",
    );
    console.info("Demo password: SiteTrackDemo123!");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  console.error("seed failed", error);
  process.exitCode = 1;
});
