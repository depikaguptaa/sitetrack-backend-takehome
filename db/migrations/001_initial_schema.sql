CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE app_role AS ENUM ('user', 'company_store_manager', 'superadmin');
CREATE TYPE task_status AS ENUM ('not_started', 'in_progress', 'done');
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
CREATE TYPE delivery_status AS ENUM ('in_transit', 'delivered', 'rejected', 'cancelled');
CREATE TYPE store_kind AS ENUM ('company', 'project');

CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  role app_role NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id, expires_at DESC);

CREATE TABLE projects (
  project_no BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  planned_start DATE NOT NULL,
  planned_end DATE NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (planned_end >= planned_start)
);
CREATE INDEX projects_live_start_idx ON projects(planned_start, project_no) WHERE deleted_at IS NULL;
CREATE INDEX projects_live_name_idx ON projects(lower(name), project_no) WHERE deleted_at IS NULL;
CREATE INDEX projects_live_search_idx ON projects USING gin(name gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE project_members (
  project_no BIGINT NOT NULL REFERENCES projects(project_no) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_no, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id, project_no);

CREATE TABLE project_invitations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_no BIGINT NOT NULL REFERENCES projects(project_no) ON DELETE CASCADE,
  invited_user_id BIGINT NOT NULL REFERENCES users(id),
  invited_by BIGINT NOT NULL REFERENCES users(id),
  status invitation_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX project_invites_one_pending_idx ON project_invitations(project_no, invited_user_id) WHERE status = 'pending';
CREATE INDEX project_invites_user_idx ON project_invitations(invited_user_id, created_at DESC);
CREATE INDEX project_invites_project_idx ON project_invitations(project_no, status, created_at DESC);

CREATE TABLE notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitation_id BIGINT NOT NULL UNIQUE REFERENCES project_invitations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE project_task_counters (
  project_no BIGINT PRIMARY KEY REFERENCES projects(project_no) ON DELETE CASCADE,
  next_task_no INTEGER NOT NULL DEFAULT 1 CHECK (next_task_no > 0)
);

CREATE TABLE tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_no BIGINT NOT NULL REFERENCES projects(project_no) ON DELETE CASCADE,
  task_no INTEGER NOT NULL CHECK (task_no > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  planned_start DATE NOT NULL,
  planned_end DATE NOT NULL,
  status task_status NOT NULL DEFAULT 'not_started',
  deleted_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (planned_end >= planned_start),
  UNIQUE (project_no, task_no),
  UNIQUE (id, project_no)
);
CREATE INDEX tasks_project_status_idx ON tasks(project_no, status, task_no) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_start_idx ON tasks(project_no, planned_start, task_no) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_end_idx ON tasks(project_no, planned_end, task_no) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_name_idx ON tasks(project_no, lower(name), task_no) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_search_idx ON tasks USING gin(name gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE task_dependencies (
  project_no BIGINT NOT NULL,
  task_id BIGINT NOT NULL,
  depends_on_task_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id, project_no) REFERENCES tasks(id, project_no) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id, project_no) REFERENCES tasks(id, project_no) ON DELETE CASCADE
);
CREATE INDEX task_dependencies_predecessor_idx ON task_dependencies(project_no, depends_on_task_id, task_id);

CREATE TABLE materials (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 240),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 120),
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 40),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX materials_name_idx ON materials(lower(name), id) WHERE active;
CREATE INDEX materials_category_idx ON materials(category, id) WHERE active;
CREATE INDEX materials_search_idx ON materials USING gin(name gin_trgm_ops) WHERE active;

CREATE TABLE stores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind store_kind NOT NULL,
  project_no BIGINT UNIQUE REFERENCES projects(project_no) ON DELETE CASCADE,
  CHECK ((kind = 'company' AND project_no IS NULL) OR (kind = 'project' AND project_no IS NOT NULL))
);
CREATE UNIQUE INDEX stores_single_company_idx ON stores(kind) WHERE kind = 'company';

CREATE TABLE stock_balances (
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES materials(id),
  quantity NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_point NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_delivery_at TIMESTAMPTZ,
  PRIMARY KEY (store_id, material_id)
);
CREATE INDEX stock_material_idx ON stock_balances(material_id, store_id);

CREATE TABLE deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_store_id BIGINT NOT NULL REFERENCES stores(id),
  destination_store_id BIGINT NOT NULL REFERENCES stores(id),
  status delivery_status NOT NULL DEFAULT 'in_transit',
  sent_by BIGINT NOT NULL REFERENCES users(id),
  received_by BIGINT REFERENCES users(id),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ,
  CHECK (source_store_id <> destination_store_id)
);
CREATE INDEX deliveries_source_date_idx ON deliveries(source_store_id, sent_at DESC, id DESC);
CREATE INDEX deliveries_destination_date_idx ON deliveries(destination_store_id, sent_at DESC, id DESC);
CREATE INDEX deliveries_status_date_idx ON deliveries(status, sent_at DESC, id DESC);

CREATE TABLE delivery_lines (
  delivery_id BIGINT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES materials(id),
  quantity NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (delivery_id, material_id)
);
CREATE INDEX delivery_lines_material_idx ON delivery_lines(material_id, delivery_id);

INSERT INTO stores(kind, project_no) VALUES ('company', NULL);

CREATE FUNCTION enforce_delivery_store_direction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind store_kind; destination_kind store_kind;
BEGIN
  SELECT kind INTO source_kind FROM stores WHERE id = NEW.source_store_id;
  SELECT kind INTO destination_kind FROM stores WHERE id = NEW.destination_store_id;
  IF source_kind IS NULL OR destination_kind IS NULL OR source_kind = destination_kind THEN
    RAISE EXCEPTION 'deliveries must move between the company store and one project store';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deliveries_store_direction_check BEFORE INSERT OR UPDATE OF source_store_id, destination_store_id
ON deliveries FOR EACH ROW EXECUTE FUNCTION enforce_delivery_store_direction();

CREATE FUNCTION ensure_project_has_admin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining_admins INTEGER;
BEGIN
  IF OLD.is_admin AND (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NOT NEW.is_admin)) THEN
    SELECT count(*) INTO remaining_admins FROM project_members
      WHERE project_no = OLD.project_no AND is_admin AND user_id <> OLD.user_id;
    IF remaining_admins = 0 THEN RAISE EXCEPTION 'a project must always have at least one admin'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER project_admin_required BEFORE DELETE OR UPDATE OF is_admin ON project_members
FOR EACH ROW EXECUTE FUNCTION ensure_project_has_admin();

CREATE FUNCTION create_project_store() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stores(kind, project_no) VALUES ('project', NEW.project_no);
  INSERT INTO project_task_counters(project_no, next_task_no) VALUES (NEW.project_no, 1);
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_create_store AFTER INSERT ON projects
FOR EACH ROW EXECUTE FUNCTION create_project_store();
