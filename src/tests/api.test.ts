import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";

const app = createApp();
const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
type TestAccount = {
  id: string;
  name: string;
  email: string;
  role: string;
  token: string;
};

async function register(name: string, role = "user"): Promise<TestAccount> {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${unique}@example.test`;
  const response = await request(app)
    .post("/auth/register")
    .send({ name, email, password: "SecureDemoPassword123!", role });
  expect(response.status).toBe(201);
  expect(response.body.user.password_hash).toBeUndefined();
  return { ...response.body.user, token: response.body.accessToken };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("SiteTrack API integration", () => {
  let admin: TestAccount;
  let member: TestAccount;
  let outsider: TestAccount;
  let companyManager: TestAccount;
  let superadmin: TestAccount;
  let projectId: string;
  let materialId: number;

  beforeAll(async () => {
    await query("TRUNCATE users, projects, materials RESTART IDENTITY CASCADE");
    await query(
      "INSERT INTO stores(kind, project_no) VALUES ('company', NULL)",
    );
    admin = await register("Project Admin");
    member = await register("Invited Member");
    outsider = await register("Outsider");
    companyManager = await register("Store Manager", "company_store_manager");
    superadmin = await register("Super Admin", "superadmin");
    const project = await request(app)
      .post("/projects")
      .set(auth(admin.token))
      .send({
        name: "Test Build",
        plannedStart: "2026-01-01",
        plannedEnd: "2027-01-01",
      });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;
  });

  afterAll(async () => {
    await closePool();
  });

  it("registers, authenticates with one error for unknown and wrong-password accounts, and revokes logout sessions", async () => {
    const wrong = await request(app)
      .post("/auth/login")
      .send({ email: admin.email, password: "wrong-password" });
    const unknown = await request(app)
      .post("/auth/login")
      .send({
        email: `absent.${unique}@example.test`,
        password: "wrong-password",
      });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    const login = await request(app)
      .post("/auth/login")
      .send({ email: admin.email, password: "SecureDemoPassword123!" });
    expect(
      (await request(app).get("/auth/me").set(auth(login.body.accessToken)))
        .status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/auth/logout")
          .set(auth(login.body.accessToken))
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get("/auth/me").set(auth(login.body.accessToken)))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .patch(`/auth/users/${outsider.id}/role`)
          .set(auth(admin.token))
          .send({ role: "superadmin" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/auth/users/${outsider.id}/role`)
          .set(auth(superadmin.token))
          .send({ role: "company_store_manager" })
      ).status,
    ).toBe(200);
    const changedRole = await request(app)
      .get("/auth/me")
      .set(auth(outsider.token));
    expect(changedRole.body.user.role).toBe("company_store_manager");
    expect(
      (
        await request(app)
          .patch(`/auth/users/${outsider.id}/role`)
          .set(auth(superadmin.token))
          .send({ role: "user" })
      ).status,
    ).toBe(200);
  });

  it("hides projects from nonmembers and makes accepted invitations and member changes effective immediately", async () => {
    expect(
      (
        await request(app)
          .get(`/projects/${projectId}`)
          .set(auth(outsider.token))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/projects/${projectId}/invitations`)
          .set(auth(outsider.token))
      ).status,
    ).toBe(404);
    const beyondProjectPage = await request(app)
      .get("/projects?page=2&limit=1")
      .set(auth(admin.token));
    expect(beyondProjectPage.body.items).toEqual([]);
    expect(beyondProjectPage.body.total).toBe(1);
    const invite = await request(app)
      .post(`/projects/${projectId}/invitations`)
      .set(auth(admin.token))
      .send({ email: member.email });
    expect(invite.status).toBe(201);
    const invitationId = invite.body.invitation.id;
    const notifications = await request(app)
      .get("/notifications")
      .set(auth(member.token));
    expect(notifications.status).toBe(200);
    expect(notifications.body.unreadCount).toBe(1);
    const beyondNotificationPage = await request(app)
      .get("/notifications?page=2&limit=1")
      .set(auth(member.token));
    expect(beyondNotificationPage.body.items).toEqual([]);
    expect(beyondNotificationPage.body.total).toBe(1);
    expect(beyondNotificationPage.body.unreadCount).toBe(1);
    expect(
      (
        await request(app)
          .post(`/notifications/${invitationId}/respond`)
          .set(auth(member.token))
          .send({ response: "accept" })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/projects/${projectId}`).set(auth(member.token)))
        .status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(`/projects/${projectId}/members/${member.id}/admin`)
          .set(auth(admin.token))
          .send({ isAdmin: true })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(`/projects/${projectId}/members/${member.id}/admin`)
          .set(auth(admin.token))
          .send({ isAdmin: false })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .delete(`/projects/${projectId}/members/${admin.id}`)
          .set(auth(admin.token))
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .delete(`/projects/${projectId}/members/${member.id}`)
          .set(auth(admin.token))
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get(`/projects/${projectId}`).set(auth(member.token)))
        .status,
    ).toBe(404);
    const withdrawn = await request(app)
      .post(`/projects/${projectId}/invitations`)
      .set(auth(admin.token))
      .send({ email: outsider.email });
    expect(withdrawn.status).toBe(201);
    expect(
      (
        await request(app)
          .delete(
            `/projects/${projectId}/invitations/${withdrawn.body.invitation.id}`,
          )
          .set(auth(admin.token))
      ).status,
    ).toBe(204);
    const rejected = await request(app)
      .post(`/projects/${projectId}/invitations`)
      .set(auth(admin.token))
      .send({ email: outsider.email });
    expect(rejected.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/notifications/${rejected.body.invitation.id}/respond`)
          .set(auth(outsider.token))
          .send({ response: "reject" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(`/projects/${projectId}`)
          .set(auth(outsider.token))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/projects/${projectId}/invitations`)
          .set(auth(superadmin.token))
          .send({ email: outsider.email })
      ).status,
    ).toBe(403);

    await query(
      `WITH new_users AS (
         INSERT INTO users(name, email, password_hash)
         SELECT 'Bulk Invite ' || n, 'bulk-invite-' || n || '.' || $2 || '@example.test', 'test-only-hash'
         FROM generate_series(1, 101) AS gs(n)
         RETURNING id
       ), new_invitations AS (
         INSERT INTO project_invitations(project_no, invited_user_id, invited_by)
         SELECT 1, id, $1 FROM new_users
         RETURNING id, invited_user_id, created_at
       )
       INSERT INTO notifications(user_id, invitation_id, created_at)
       SELECT invited_user_id, id, created_at FROM new_invitations`,
      [admin.id, unique],
    );
    const firstInvitationPage = await request(app)
      .get(`/projects/${projectId}/invitations?limit=100&page=1`)
      .set(auth(admin.token));
    expect(firstInvitationPage.body.items).toHaveLength(100);
    expect(firstInvitationPage.body.total).toBe(101);
    const nextInvitationPage = await request(app)
      .get(`/projects/${projectId}/invitations?limit=100&page=2`)
      .set(auth(admin.token));
    expect(nextInvitationPage.body.items).toHaveLength(1);
    expect(nextInvitationPage.body.items[0].status).toBe("pending");
    expect(nextInvitationPage.body.total).toBe(101);
  });

  it("allocates stable task IDs, enforces a DAG, derives task details, and validates status actions", async () => {
    const createTask = async (name: string) =>
      request(app)
        .post(`/projects/${projectId}/tasks`)
        .set(auth(admin.token))
        .send({ name, plannedStart: "2026-01-01", plannedEnd: "2027-01-01" });
    const a = await createTask("Foundation");
    const b = await createTask("Columns");
    const c = await createTask("Roof");
    expect(a.body.task.id).toBe("PRJ-0001-T-0001");
    expect(b.body.task.id).toBe("PRJ-0001-T-0002");
    expect(
      (
        await request(app)
          .put(`/projects/${projectId}/tasks/${b.body.task.id}/dependencies`)
          .set(auth(admin.token))
          .send({ dependsOn: [a.body.task.id] })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .put(`/projects/${projectId}/tasks/${c.body.task.id}/dependencies`)
          .set(auth(admin.token))
          .send({ dependsOn: [b.body.task.id] })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .put(`/projects/${projectId}/tasks/${a.body.task.id}/dependencies`)
          .set(auth(admin.token))
          .send({ dependsOn: [c.body.task.id] })
      ).status,
    ).toBe(400);
    const details = await request(app)
      .get(`/projects/${projectId}/tasks/${c.body.task.id}`)
      .set(auth(admin.token));
    expect(details.status).toBe(200);
    expect(details.body.waitsOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.body.task.id, stepsAway: 2 }),
        expect.objectContaining({ id: b.body.task.id, stepsAway: 1 }),
      ]),
    );
    expect(
      (
        await request(app)
          .post(`/projects/${projectId}/tasks/${b.body.task.id}/actions/start`)
          .set(auth(admin.token))
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/projects/${projectId}/tasks/${a.body.task.id}/actions/start`)
          .set(auth(admin.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/projects/${projectId}/tasks/${a.body.task.id}/actions/done`)
          .set(auth(admin.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/projects/${projectId}/tasks/${b.body.task.id}/actions/start`)
          .set(auth(admin.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/projects/${projectId}/tasks/${a.body.task.id}/actions/reopen`)
          .set(auth(admin.token))
      ).status,
    ).toBe(409);
    const d = await createTask("Finishing");
    expect(
      (
        await request(app)
          .put(`/projects/${projectId}/tasks/${d.body.task.id}/dependencies`)
          .set(auth(admin.token))
          .send({ dependsOn: [c.body.task.id, a.body.task.id] })
      ).status,
    ).toBe(200);
    const shortestPaths = await request(app)
      .get(`/projects/${projectId}/tasks/${d.body.task.id}`)
      .set(auth(admin.token));
    expect(shortestPaths.body.waitsOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.body.task.id, stepsAway: 1 }),
        expect.objectContaining({ id: b.body.task.id, stepsAway: 2 }),
        expect.objectContaining({ id: c.body.task.id, stepsAway: 1 }),
      ]),
    );
    const projectSummary = await request(app)
      .get("/projects?search=Test%20Build")
      .set(auth(admin.token));
    expect(projectSummary.status).toBe(200);
    expect(projectSummary.body.items[0].taskCounts).toEqual({
      notStarted: 2,
      inProgress: 1,
      done: 1,
    });
    expect(projectSummary.body.items[0].blockedTaskCount).toBe(2);
    expect(
      (
        await request(app)
          .delete(`/projects/${projectId}/tasks/${c.body.task.id}`)
          .set(auth(admin.token))
      ).status,
    ).toBe(204);
    const afterDependencyDelete = await request(app)
      .get(`/projects/${projectId}/tasks/${d.body.task.id}`)
      .set(auth(admin.token));
    expect(afterDependencyDelete.body.waitsOn).toEqual([
      expect.objectContaining({ id: a.body.task.id, stepsAway: 1 }),
    ]);
    const updatedSummary = await request(app)
      .get("/projects?search=Test%20Build")
      .set(auth(admin.token));
    expect(updatedSummary.body.items[0].taskCounts).toEqual({
      notStarted: 1,
      inProgress: 1,
      done: 1,
    });
    expect(updatedSummary.body.items[0].blockedTaskCount).toBe(0);
    const deleted = await createTask("Deleted task");
    expect(deleted.body.task.id).toBe("PRJ-0001-T-0005");
    expect(
      (
        await request(app)
          .delete(`/projects/${projectId}/tasks/${deleted.body.task.id}`)
          .set(auth(admin.token))
      ).status,
    ).toBe(204);
    const next = await createTask("Next task");
    expect(next.body.task.id).toBe("PRJ-0001-T-0006");
  });

  it("moves stock atomically and only exposes company store data to store roles", async () => {
    const material = await request(app)
      .post("/materials")
      .set(auth(admin.token))
      .send({ name: "Test OPC Cement", category: "Cement", unit: "bag" });
    expect(material.status).toBe(201);
    materialId = Number(material.body.material.id);
    expect(
      (
        await request(app)
          .post(`/company-store/stock/${materialId}/add`)
          .set(auth(companyManager.token))
          .send({ quantity: "100" })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .put(`/company-store/stock/${materialId}/reorder-point`)
          .set(auth(companyManager.token))
          .send({ reorderPoint: "0" })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get("/company-store/stock").set(auth(admin.token)))
        .status,
    ).toBe(404);
    const overflow = await request(app)
      .post("/company-store/deliveries")
      .set(auth(companyManager.token))
      .send({
        projectId,
        lines: [
          { materialId, quantity: "999999999999999.999" },
          { materialId, quantity: "999999999999999.999" },
        ],
      });
    expect(overflow.status).toBe(400);
    expect(overflow.body.error.code).toBe("invalid_quantity");
    const outgoing = await request(app)
      .post("/company-store/deliveries")
      .set(auth(companyManager.token))
      .send({ projectId, lines: [{ materialId, quantity: "10" }] });
    expect(outgoing.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/deliveries/${outgoing.body.deliveryId}/record`)
          .set(auth(admin.token))
      ).status,
    ).toBe(200);
    const returned = await request(app)
      .post(`/projects/${projectId}/deliveries`)
      .set(auth(admin.token))
      .send({ lines: [{ materialId, quantity: "3" }] });
    expect(returned.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/deliveries/${returned.body.deliveryId}/record`)
          .set(auth(companyManager.token))
      ).status,
    ).toBe(200);
    const history = await request(app)
      .get(`/projects/${projectId}/deliveries?limit=10`)
      .set(auth(admin.token));
    const returnedDelivery = history.body.items.find(
      (delivery: { id: string }) => delivery.id === returned.body.deliveryId,
    );
    expect(returnedDelivery.lines[0].materialId).toBe(String(materialId));
    expect(returnedDelivery.lines[0].quantity).toBe("3.000");
    const concurrent = await Promise.all([
      request(app)
        .post("/company-store/deliveries")
        .set(auth(companyManager.token))
        .send({ projectId, lines: [{ materialId, quantity: "60" }] }),
      request(app)
        .post("/company-store/deliveries")
        .set(auth(companyManager.token))
        .send({ projectId, lines: [{ materialId, quantity: "60" }] }),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([201, 409]);
    const sent = concurrent.find((r) => r.status === 201)!;
    expect(
      (
        await request(app)
          .post(`/deliveries/${sent.body.deliveryId}/record`)
          .set(auth(admin.token))
      ).status,
    ).toBe(200);
    const stock = await request(app)
      .get(`/company-store/stock?search=Test%20OPC%20Cement`)
      .set(auth(companyManager.token));
    expect(stock.status).toBe(200);
    expect(stock.body.items[0].quantity).toBe("33.000");
    expect(stock.body.items[0].status).toBe("available");
    expect(
      (
        await request(app)
          .get(`/projects/${projectId}/store?search=Test%20OPC%20Cement`)
          .set(auth(admin.token))
      ).body.items[0].quantity,
    ).toBe("67.000");

    await request(app)
      .post(`/company-store/stock/${materialId}/add`)
      .set(auth(companyManager.token))
      .send({ quantity: "100" });
    const pendingDeliveries = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app)
          .post("/company-store/deliveries")
          .set(auth(companyManager.token))
          .send({ projectId, lines: [{ materialId, quantity: "1" }] }),
      ),
    );
    expect(pendingDeliveries.every((response) => response.status === 201)).toBe(
      true,
    );
    const received = await Promise.all(
      pendingDeliveries.map((response) =>
        request(app)
          .post(`/deliveries/${response.body.deliveryId}/record`)
          .set(auth(admin.token)),
      ),
    );
    expect(
      received
        .map((response) => response.status)
        .every((status) => status === 200),
    ).toBe(true);

    const companyCancellation = await request(app)
      .post("/company-store/deliveries")
      .set(auth(companyManager.token))
      .send({ projectId, lines: [{ materialId, quantity: "5" }] });
    expect(companyCancellation.status).toBe(201);
    const cancelled = await request(app)
      .post(`/deliveries/${companyCancellation.body.deliveryId}/cancel`)
      .set(auth(companyManager.token));
    expect(cancelled.body.status).toBe("cancelled");

    const companyRejection = await request(app)
      .post("/company-store/deliveries")
      .set(auth(companyManager.token))
      .send({ projectId, lines: [{ materialId, quantity: "5" }] });
    expect(companyRejection.status).toBe(201);
    const rejectedByProject = await request(app)
      .post(`/deliveries/${companyRejection.body.deliveryId}/reject`)
      .set(auth(admin.token));
    expect(rejectedByProject.body.status).toBe("rejected");

    const projectCancellation = await request(app)
      .post(`/projects/${projectId}/deliveries`)
      .set(auth(admin.token))
      .send({ lines: [{ materialId, quantity: "2" }] });
    expect(projectCancellation.status).toBe(201);
    const cancelledByProject = await request(app)
      .post(`/deliveries/${projectCancellation.body.deliveryId}/cancel`)
      .set(auth(admin.token));
    expect(cancelledByProject.body.status).toBe("cancelled");

    const projectRejection = await request(app)
      .post(`/projects/${projectId}/deliveries`)
      .set(auth(admin.token))
      .send({ lines: [{ materialId, quantity: "2" }] });
    expect(projectRejection.status).toBe(201);
    const rejectedByCompany = await request(app)
      .post(`/deliveries/${projectRejection.body.deliveryId}/reject`)
      .set(auth(companyManager.token));
    expect(rejectedByCompany.body.status).toBe("rejected");

    const finalCompanyStock = await request(app)
      .get(`/company-store/stock?search=Test%20OPC%20Cement`)
      .set(auth(companyManager.token));
    expect(finalCompanyStock.body.items[0].quantity).toBe("113.000");
    const finalProjectStock = await request(app)
      .get(`/projects/${projectId}/store?search=Test%20OPC%20Cement`)
      .set(auth(admin.token));
    expect(finalProjectStock.body.items[0].quantity).toBe("87.000");
  });
});
