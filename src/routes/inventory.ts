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
  requireCompanyStore,
  requireEnum,
  requiredString,
  userOf,
} from "../http.js";
import { HttpError } from "../auth.js";

const statuses = ["in_transit", "delivered", "rejected", "cancelled"] as const;
const stockStatuses = ["out_of_stock", "low_stock", "available"] as const;

function quantityText(
  value: unknown,
  name = "quantity",
  allowZero = false,
): string {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/.test(text))
    throw new HttpError(
      400,
      "invalid_quantity",
      `${name} must be a positive decimal with at most 3 fractional digits`,
    );
  const [whole = "0", fraction = ""] = text.split(".");
  if (
    !allowZero &&
    BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3)) <= 0n
  )
    throw new HttpError(
      400,
      "invalid_quantity",
      `${name} must be greater than zero`,
    );
  return `${whole}.${(fraction + "000").slice(0, 3)}`;
}

function positiveLineItems(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20_000)
    throw new HttpError(
      400,
      "invalid_lines",
      "lines must contain between 1 and 20,000 material entries",
    );
  const byMaterial = new Map<number, bigint>();
  for (const item of value) {
    const row = item as { materialId?: unknown; quantity?: unknown };
    const materialId = positiveInt(row?.materialId, "materialId");
    const normalized = quantityText(row?.quantity);
    const [whole, fraction] = normalized.split(".");
    const milli = BigInt(whole!) * 1000n + BigInt(fraction!);
    const combined = (byMaterial.get(materialId) ?? 0n) + milli;
    if (combined > 999999999999999999n)
      throw new HttpError(
        400,
        "invalid_quantity",
        "Combined quantity exceeds the supported maximum",
      );
    byMaterial.set(materialId, combined);
  }
  return [...byMaterial.entries()]
    .map(([materialId, milli]) => ({
      materialId,
      quantity: `${milli / 1000n}.${String(milli % 1000n).padStart(3, "0")}`,
    }))
    .sort((a, b) => a.materialId - b.materialId);
}

async function companyStoreId() {
  const result = await query<{ id: string }>(
    "SELECT id FROM stores WHERE kind = 'company'",
  );
  if (!result.rows[0]) throw new Error("company store row is missing");
  return result.rows[0].id;
}

async function projectStoreId(projectNo: number) {
  const result = await query<{ id: string }>(
    "SELECT id FROM stores WHERE kind = 'project' AND project_no = $1",
    [projectNo],
  );
  if (!result.rows[0])
    throw new HttpError(404, "not_found", "Project store not found");
  return result.rows[0].id;
}

async function initiateDelivery(
  sourceStoreId: string,
  destinationStoreId: string,
  lines: ReturnType<typeof positiveLineItems>,
  userId: string,
) {
  return transaction(async (client) => {
    const stores = await client.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM stores WHERE id = ANY($1::bigint[]) ORDER BY id",
      [[sourceStoreId, destinationStoreId]],
    );
    if (stores.rowCount !== 2 || stores.rows[0]!.kind === stores.rows[1]!.kind)
      throw new HttpError(
        400,
        "invalid_route",
        "Deliveries must move between the company store and one project store",
      );
    const storeIds = [sourceStoreId, destinationStoreId];
    const materialIds = lines.map((line) => line.materialId);
    const active = await client.query<{ id: string }>(
      "SELECT id FROM materials WHERE id = ANY($1::bigint[]) AND active",
      [materialIds],
    );
    if (active.rowCount !== materialIds.length)
      throw new HttpError(
        400,
        "inactive_material",
        "All delivery materials must exist and be active",
      );
    await client.query(
      `INSERT INTO stock_balances(store_id, material_id, quantity)
       SELECT stores.store_id, material_ids.material_id, 0 FROM unnest($1::bigint[]) stores(store_id) CROSS JOIN unnest($2::bigint[]) material_ids(material_id)
       ON CONFLICT (store_id, material_id) DO NOTHING`,
      [storeIds, materialIds],
    );
    const balances = await client.query<{
      store_id: string;
      material_id: string;
      quantity: string;
    }>(
      "SELECT store_id, material_id, quantity FROM stock_balances WHERE store_id = ANY($1::bigint[]) AND material_id = ANY($2::bigint[]) ORDER BY store_id, material_id FOR UPDATE",
      [storeIds, materialIds],
    );
    void balances; // The ordered FOR UPDATE locks serialize stock updates; the numeric UPDATE predicate is the exact balance check.
    const delivery = await client.query<{ id: string }>(
      "INSERT INTO deliveries(source_store_id, destination_store_id, sent_by) VALUES ($1, $2, $3) RETURNING id",
      [sourceStoreId, destinationStoreId, userId],
    );
    const deliveryId = delivery.rows[0]!.id;
    for (const line of lines) {
      const changed = await client.query(
        "UPDATE stock_balances SET quantity = quantity - $1::numeric, updated_at = now(), last_delivery_at = now() WHERE store_id = $2 AND material_id = $3 AND quantity >= $1::numeric",
        [line.quantity, sourceStoreId, line.materialId],
      );
      if (!changed.rowCount)
        throw new HttpError(
          409,
          "insufficient_stock",
          `Insufficient stock for material ${line.materialId}`,
        );
      await client.query(
        "INSERT INTO delivery_lines(delivery_id, material_id, quantity) VALUES ($1, $2, $3)",
        [deliveryId, line.materialId, line.quantity],
      );
    }
    return deliveryId;
  });
}

export const materialsRouter = Router();
materialsRouter.use(authRequired);

materialsRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const { limit, page, offset } = pagination(req, 100);
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 200)
        : "";
    const category =
      typeof req.query.category === "string"
        ? req.query.category.trim().slice(0, 120)
        : "";
    const { result, total } = await queryPage<Record<string, unknown>>(
      `SELECT id, name, category, unit, count(*) OVER()::int AS total_count FROM materials
     WHERE active AND ($1::text = '' OR name ILIKE '%' || $1 || '%') AND ($2::text = '' OR category = $2)
     ORDER BY lower(name), id LIMIT $3 OFFSET $4`,
      [search, category, limit, offset],
      2,
      3,
    );
    res.json({
      items: result.rows.map(({ total_count: _count, ...m }) => m),
      page,
      limit,
      total,
    });
  }),
);

materialsRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const name = requiredString(req.body?.name, "name", 240);
    const category = requiredString(req.body?.category, "category", 120);
    const unit = requiredString(req.body?.unit, "unit", 40);
    const result = await query<{
      id: string;
      name: string;
      category: string;
      unit: string;
    }>(
      "INSERT INTO materials(name, category, unit) VALUES ($1, $2, $3) RETURNING id, name, category, unit",
      [name, category, unit],
    );
    res.status(201).json({ material: result.rows[0] });
  }),
);

materialsRouter.patch(
  "/:materialId",
  asyncRoute(async (req, res) => {
    const materialId = positiveInt(req.params.materialId, "materialId");
    const current = await query<{
      name: string;
      category: string;
      unit: string;
    }>("SELECT name, category, unit FROM materials WHERE id = $1 AND active", [
      materialId,
    ]);
    const row = current.rows[0];
    if (!row) throw new HttpError(404, "not_found", "Material not found");
    const name =
      req.body?.name === undefined
        ? row.name
        : requiredString(req.body.name, "name", 240);
    const category =
      req.body?.category === undefined
        ? row.category
        : requiredString(req.body.category, "category", 120);
    const unit =
      req.body?.unit === undefined
        ? row.unit
        : requiredString(req.body.unit, "unit", 40);
    const updated = await query(
      "UPDATE materials SET name = $1, category = $2, unit = $3 WHERE id = $4 RETURNING id, name, category, unit",
      [name, category, unit, materialId],
    );
    res.json({ material: updated.rows[0] });
  }),
);

materialsRouter.delete(
  "/:materialId",
  asyncRoute(async (req, res) => {
    const materialId = positiveInt(req.params.materialId, "materialId");
    const usage = await query(
      "SELECT EXISTS(SELECT 1 FROM stock_balances WHERE material_id = $1) OR EXISTS(SELECT 1 FROM delivery_lines WHERE material_id = $1) AS used",
      [materialId],
    );
    if (!usage.rows[0]?.used) {
      const deleted = await query("DELETE FROM materials WHERE id = $1", [
        materialId,
      ]);
      if (!deleted.rowCount)
        throw new HttpError(404, "not_found", "Material not found");
    } else {
      throw new HttpError(
        409,
        "material_in_use",
        "A material used in stock or delivery history cannot be removed",
      );
    }
    res.status(204).end();
  }),
);

export const projectStoreRouter = Router({ mergeParams: true });
projectStoreRouter.use(authRequired);

projectStoreRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const { limit, page, offset } = pagination(req, 100);
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 200)
        : "";
    const category =
      typeof req.query.category === "string"
        ? req.query.category.trim().slice(0, 120)
        : "";
    const sortMap: Record<string, string> = {
      name: "lower(m.name), m.id",
      quantity: "coalesce(sb.quantity, 0) DESC, lower(m.name), m.id",
      lastDelivery: "sb.last_delivery_at DESC NULLS LAST, lower(m.name), m.id",
    };
    const sort = typeof req.query.sort === "string" ? req.query.sort : "name";
    const order = sortMap[sort];
    if (!order)
      throw new HttpError(
        400,
        "invalid_sort",
        "sort must be name, quantity, or lastDelivery",
      );
    const storeId = await projectStoreId(projectNo);
    const { result, total } = await queryPage<Record<string, unknown>>(
      `SELECT m.id AS material_id, m.name, m.category, m.unit, coalesce(sb.quantity, 0)::text AS quantity,
       sb.last_delivery_at, count(*) OVER()::int AS total_count
     FROM materials m LEFT JOIN stock_balances sb ON sb.material_id = m.id AND sb.store_id = $1
     WHERE (m.active OR coalesce(sb.quantity, 0) > 0) AND ($2::text = '' OR m.name ILIKE '%' || $2 || '%') AND ($3::text = '' OR m.category = $3)
     ORDER BY ${order} LIMIT $4 OFFSET $5`,
      [storeId, search, category, limit, offset],
      3,
      4,
    );
    res.json({
      items: result.rows.map((r) => ({
        id: r.material_id,
        name: r.name,
        category: r.category,
        unit: r.unit,
        quantity: r.quantity,
        lastDeliveryAt: r.last_delivery_at,
      })),
      page,
      limit,
      total,
    });
  }),
);

export const companyStoreRouter = Router();
companyStoreRouter.use(authRequired);

companyStoreRouter.get(
  "/stock",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    requireCompanyStore(user);
    const { limit, page, offset } = pagination(req, 100);
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 200)
        : "";
    const category =
      typeof req.query.category === "string"
        ? req.query.category.trim().slice(0, 120)
        : "";
    const status =
      req.query.status === undefined
        ? null
        : requireEnum(req.query.status, stockStatuses, "status");
    const sortMap: Record<string, string> = {
      name: "lower(name), id",
      quantity: "quantity DESC, lower(name), id",
      status: "stock_status, lower(name), id",
    };
    const sort = typeof req.query.sort === "string" ? req.query.sort : "name";
    const order = sortMap[sort];
    if (!order)
      throw new HttpError(
        400,
        "invalid_sort",
        "sort must be name, quantity, or status",
      );
    const companyId = await companyStoreId();
    const { result, total } = await queryPage<Record<string, unknown>>(
      `WITH transit AS (
       SELECT dl.material_id, sum(dl.quantity)::numeric(18,3) AS quantity
       FROM deliveries d JOIN delivery_lines dl ON dl.delivery_id = d.id
       WHERE d.source_store_id = $1 AND d.status = 'in_transit' GROUP BY dl.material_id
     ), stock_rows AS (
       SELECT m.id, m.name, m.category, m.unit, coalesce(sb.quantity, 0)::numeric(18,3) AS quantity,
         coalesce(sb.reorder_point, 0)::numeric(18,3) AS reorder_point, coalesce(t.quantity, 0)::numeric(18,3) AS in_transit,
         CASE WHEN coalesce(sb.quantity, 0) = 0 THEN 'out_of_stock'
           WHEN coalesce(sb.quantity, 0) <= coalesce(sb.reorder_point, 0) THEN 'low_stock' ELSE 'available' END AS stock_status
       FROM materials m LEFT JOIN stock_balances sb ON sb.material_id = m.id AND sb.store_id = $1
       LEFT JOIN transit t ON t.material_id = m.id WHERE m.active OR coalesce(sb.quantity, 0) > 0
     )
     SELECT *, count(*) OVER()::int AS total_count FROM stock_rows
     WHERE ($2::text = '' OR name ILIKE '%' || $2 || '%') AND ($3::text = '' OR category = $3) AND ($4::text IS NULL OR stock_status = $4)
     ORDER BY ${order} LIMIT $5 OFFSET $6`,
      [companyId, search, category, status, limit, offset],
      4,
      5,
    );
    res.json({
      items: result.rows.map((r) => ({
        materialId: r.id,
        name: r.name,
        category: r.category,
        unit: r.unit,
        quantity: r.quantity,
        quantityInTransit: r.in_transit,
        reorderPoint: r.reorder_point,
        status: r.stock_status,
      })),
      page,
      limit,
      total,
    });
  }),
);

companyStoreRouter.post(
  "/stock/:materialId/add",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    requireCompanyStore(user);
    const materialId = positiveInt(req.params.materialId, "materialId");
    const quantity = quantityText(req.body?.quantity);
    const storeId = await companyStoreId();
    const result = await query<{ quantity: string }>(
      `INSERT INTO stock_balances(store_id, material_id, quantity, updated_at)
     SELECT $1, id, $3::numeric, now() FROM materials WHERE id = $2 AND active
     ON CONFLICT (store_id, material_id) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
     RETURNING quantity::text`,
      [storeId, materialId, quantity],
    );
    if (!result.rowCount)
      throw new HttpError(404, "not_found", "Active material not found");
    res.status(201).json({ materialId, quantity: result.rows[0]!.quantity });
  }),
);

companyStoreRouter.put(
  "/stock/:materialId/reorder-point",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    requireCompanyStore(user);
    const materialId = positiveInt(req.params.materialId, "materialId");
    const reorderPoint = quantityText(
      req.body?.reorderPoint,
      "reorderPoint",
      true,
    );
    const storeId = await companyStoreId();
    const result = await query<{ reorder_point: string }>(
      `INSERT INTO stock_balances(store_id, material_id, quantity, reorder_point)
     SELECT $1, id, 0, $3::numeric FROM materials WHERE id = $2 AND active
     ON CONFLICT (store_id, material_id) DO UPDATE SET reorder_point = EXCLUDED.reorder_point, updated_at = now()
     RETURNING reorder_point::text`,
      [storeId, materialId, reorderPoint],
    );
    if (!result.rowCount)
      throw new HttpError(404, "not_found", "Active material not found");
    res.json({ materialId, reorderPoint: result.rows[0]!.reorder_point });
  }),
);

export const projectDeliveriesRouter = Router({ mergeParams: true });
projectDeliveriesRouter.use(authRequired);

projectDeliveriesRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const projectId = await projectStoreId(projectNo);
    const { limit, page, offset } = pagination(req, 100);
    const direction =
      req.query.direction === undefined
        ? null
        : requireEnum(
            req.query.direction,
            ["incoming", "outgoing"] as const,
            "direction",
          );
    const status =
      req.query.status === undefined
        ? null
        : requireEnum(req.query.status, statuses, "status");
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
      `WITH filtered AS (
       SELECT d.*, (d.destination_store_id = $1) AS incoming,
         count(*) OVER()::int AS total_count
       FROM deliveries d WHERE (d.source_store_id = $1 OR d.destination_store_id = $1)
         AND ($2::text IS NULL OR (d.destination_store_id = $1) = ($2 = 'incoming'))
         AND ($3::delivery_status IS NULL OR d.status = $3)
         AND ($4::date IS NULL OR d.sent_at::date >= $4) AND ($5::date IS NULL OR d.sent_at::date <= $5)
       ORDER BY d.sent_at DESC, d.id DESC LIMIT $6 OFFSET $7
     )
     SELECT f.id, f.status, f.incoming, f.sent_at, f.received_at, f.total_count,
       sender.id AS sender_id, sender.name AS sender_name, receiver.id AS receiver_id, receiver.name AS receiver_name,
       source.project_no AS source_project_no, destination.project_no AS destination_project_no,
       coalesce(jsonb_agg(jsonb_build_object('materialId', m.id::text, 'name', m.name, 'unit', m.unit, 'quantity', dl.quantity::text) ORDER BY m.name)
         FILTER (WHERE dl.delivery_id IS NOT NULL), '[]'::jsonb) AS lines
     FROM filtered f JOIN users sender ON sender.id = f.sent_by LEFT JOIN users receiver ON receiver.id = f.received_by
     JOIN stores source ON source.id = f.source_store_id JOIN stores destination ON destination.id = f.destination_store_id
     LEFT JOIN delivery_lines dl ON dl.delivery_id = f.id LEFT JOIN materials m ON m.id = dl.material_id
     GROUP BY f.id, f.status, f.incoming, f.sent_at, f.received_at, f.total_count, sender.id, sender.name, receiver.id, receiver.name, source.project_no, destination.project_no
     ORDER BY f.sent_at DESC, f.id DESC`,
      [projectId, direction, status, dateFrom, dateTo, limit, offset],
      5,
      6,
    );
    res.json({
      items: result.rows.map((r) => ({
        id: r.id,
        direction: r.incoming ? "incoming" : "outgoing",
        status: r.status,
        lines: r.lines,
        sentAt: r.sent_at,
        receivedAt: r.received_at,
        sender: { id: r.sender_id, name: r.sender_name },
        receiver: r.receiver_id
          ? { id: r.receiver_id, name: r.receiver_name }
          : null,
        projectId: projectPublicId(projectNo),
      })),
      page,
      limit,
      total,
    });
  }),
);

projectDeliveriesRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const projectNo = asProjectNo(req.params.projectId);
    await projectAccess(projectNo, user);
    const companyId = await companyStoreId();
    const id = await initiateDelivery(
      await projectStoreId(projectNo),
      companyId,
      positiveLineItems(req.body?.lines),
      user.id,
    );
    res.status(201).json({
      deliveryId: id,
      projectId: projectPublicId(projectNo),
      status: "in_transit",
    });
  }),
);

export const companyDeliveriesRouter = Router();
companyDeliveriesRouter.use(authRequired);

companyDeliveriesRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    requireCompanyStore(user);
    const projectNo = asProjectNo(req.body?.projectId);
    const project = await query(
      "SELECT 1 FROM projects WHERE project_no = $1 AND deleted_at IS NULL",
      [projectNo],
    );
    if (!project.rowCount)
      throw new HttpError(404, "not_found", "Project not found");
    const id = await initiateDelivery(
      await companyStoreId(),
      await projectStoreId(projectNo),
      positiveLineItems(req.body?.lines),
      user.id,
    );
    res.status(201).json({
      deliveryId: id,
      projectId: projectPublicId(projectNo),
      status: "in_transit",
    });
  }),
);

companyDeliveriesRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    requireCompanyStore(user);
    const { limit, page, offset } = pagination(req, 100);
    const direction =
      req.query.direction === undefined
        ? null
        : requireEnum(
            req.query.direction,
            ["incoming", "outgoing"] as const,
            "direction",
          );
    const status =
      req.query.status === undefined
        ? null
        : requireEnum(req.query.status, statuses, "status");
    const projectNo =
      req.query.projectId === undefined
        ? null
        : asProjectNo(req.query.projectId);
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
    const companyId = await companyStoreId();
    const { result, total } = await queryPage<Record<string, unknown>>(
      `WITH filtered AS (
       SELECT d.*, (d.destination_store_id = $1) AS incoming, coalesce(source.project_no, destination.project_no) AS project_no,
         count(*) OVER()::int AS total_count
       FROM deliveries d JOIN stores source ON source.id = d.source_store_id JOIN stores destination ON destination.id = d.destination_store_id
       WHERE (d.source_store_id = $1 OR d.destination_store_id = $1)
         AND ($2::text IS NULL OR (d.destination_store_id = $1) = ($2 = 'incoming'))
         AND ($3::delivery_status IS NULL OR d.status = $3) AND ($4::bigint IS NULL OR coalesce(source.project_no, destination.project_no) = $4)
         AND ($5::date IS NULL OR d.sent_at::date >= $5) AND ($6::date IS NULL OR d.sent_at::date <= $6)
       ORDER BY d.sent_at DESC, d.id DESC LIMIT $7 OFFSET $8
     )
     SELECT f.id, f.status, f.incoming, f.project_no, f.sent_at, f.received_at, f.total_count,
       sender.id AS sender_id, sender.name AS sender_name, receiver.id AS receiver_id, receiver.name AS receiver_name,
       p.name AS project_name,
       coalesce(jsonb_agg(jsonb_build_object('materialId', m.id::text, 'name', m.name, 'unit', m.unit, 'quantity', dl.quantity::text) ORDER BY m.name)
         FILTER (WHERE dl.delivery_id IS NOT NULL), '[]'::jsonb) AS lines
     FROM filtered f JOIN projects p ON p.project_no = f.project_no JOIN users sender ON sender.id = f.sent_by LEFT JOIN users receiver ON receiver.id = f.received_by
     LEFT JOIN delivery_lines dl ON dl.delivery_id = f.id LEFT JOIN materials m ON m.id = dl.material_id
     GROUP BY f.id, f.status, f.incoming, f.project_no, f.sent_at, f.received_at, f.total_count, sender.id, sender.name, receiver.id, receiver.name, p.name
     ORDER BY f.sent_at DESC, f.id DESC`,
      [
        companyId,
        direction,
        status,
        projectNo,
        dateFrom,
        dateTo,
        limit,
        offset,
      ],
      6,
      7,
    );
    res.json({
      items: result.rows.map((r) => ({
        id: r.id,
        projectId: projectPublicId(String(r.project_no)),
        projectName: r.project_name,
        direction: r.incoming ? "incoming" : "outgoing",
        status: r.status,
        lines: r.lines,
        sentAt: r.sent_at,
        receivedAt: r.received_at,
        sender: { id: r.sender_id, name: r.sender_name },
        receiver: r.receiver_id
          ? { id: r.receiver_id, name: r.receiver_name }
          : null,
      })),
      page,
      limit,
      total,
    });
  }),
);

export const deliveriesActionRouter = Router();
deliveriesActionRouter.use(authRequired);

deliveriesActionRouter.post(
  "/:deliveryId/:action",
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    const deliveryId = positiveInt(req.params.deliveryId, "deliveryId");
    const action = req.params.action;
    if (action !== "record" && action !== "reject" && action !== "cancel")
      throw new HttpError(404, "not_found", "Delivery action not found");
    const outcome = await transaction(async (client) => {
      const result = await client.query<{
        id: string;
        source_store_id: string;
        destination_store_id: string;
        status: string;
        sent_by: string;
        source_kind: string;
        source_project_no: string | null;
        destination_kind: string;
        destination_project_no: string | null;
      }>(
        `SELECT d.id, d.source_store_id, d.destination_store_id, d.status, d.sent_by, s.kind AS source_kind, s.project_no AS source_project_no, r.kind AS destination_kind, r.project_no AS destination_project_no
       FROM deliveries d JOIN stores s ON s.id = d.source_store_id JOIN stores r ON r.id = d.destination_store_id
       WHERE d.id = $1 FOR UPDATE OF d`,
        [deliveryId],
      );
      const delivery = result.rows[0];
      if (!delivery)
        throw new HttpError(404, "not_found", "Delivery not found");
      if (delivery.status !== "in_transit")
        throw new HttpError(
          409,
          "delivery_closed",
          "Delivery is no longer in transit",
        );
      if (action === "cancel") {
        if (delivery.sent_by !== user.id)
          throw new HttpError(404, "not_found", "Delivery not found");
        if (delivery.source_kind === "company") requireCompanyStore(user);
        else if (delivery.source_project_no !== null)
          await projectAccess(
            Number(delivery.source_project_no),
            user,
            false,
            false,
            client,
          );
      } else {
        if (delivery.destination_kind === "company") requireCompanyStore(user);
        else if (delivery.destination_project_no !== null)
          await projectAccess(
            Number(delivery.destination_project_no),
            user,
            false,
            false,
            client,
          );
      }
      const lines = await client.query<{
        material_id: string;
        quantity: string;
      }>(
        "SELECT material_id, quantity::text FROM delivery_lines WHERE delivery_id = $1 ORDER BY material_id",
        [deliveryId],
      );
      const newStatus =
        action === "record"
          ? "delivered"
          : action === "reject"
            ? "rejected"
            : "cancelled";
      if (action === "record") {
        for (const line of lines.rows)
          await client.query(
            `INSERT INTO stock_balances(store_id, material_id, quantity, updated_at, last_delivery_at)
         VALUES ($1, $2, $3::numeric, now(), now())
         ON CONFLICT (store_id, material_id) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now(), last_delivery_at = now()`,
            [delivery.destination_store_id, line.material_id, line.quantity],
          );
      } else {
        for (const line of lines.rows)
          await client.query(
            `INSERT INTO stock_balances(store_id, material_id, quantity, updated_at, last_delivery_at)
         VALUES ($1, $2, $3::numeric, now(), now())
         ON CONFLICT (store_id, material_id) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now(), last_delivery_at = now()`,
            [delivery.source_store_id, line.material_id, line.quantity],
          );
      }
      await client.query(
        "UPDATE deliveries SET status = $1, received_by = $2, received_at = now() WHERE id = $3",
        [newStatus, action === "cancel" ? null : user.id, deliveryId],
      );
      return { status: newStatus };
    });
    res.json({ deliveryId, status: outcome.status });
  }),
);
