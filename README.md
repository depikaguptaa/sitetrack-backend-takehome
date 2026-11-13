# SiteTrack Backend

TypeScript and PostgreSQL API for construction projects, task dependencies, materials, project stores, and company-store deliveries. The API supports the 11 screens in the assignment. There is no frontend.

## Run it

Docker and Docker Compose are the only prerequisites for the standard run:

```bash
docker compose up --build
```

Compose starts PostgreSQL and the API, applies pending migrations, and exposes the API at `http://localhost:3000`. Readiness is available at `/health`; the OpenAPI document is at `/openapi.yaml` and `/docs` returns its location. The database volume is named `sitetrack-backend-takehome_sitetrack-db` and persists across container restarts.

The local Compose credentials and JWT key are development defaults. Set `JWT_SECRET` in a local `.env` file before any shared deployment. Production startup requires a configured secret of at least 32 characters. Do not use the demo accounts or default database password outside a local exercise environment.

## Demo data

Load the full assignment dataset into a fresh database:

```bash
docker compose exec -T api node dist/db/seed.js
```

The loader refuses to add duplicate data to a non-empty database. It uses set-based SQL and one transaction. It generates exactly:

| Table | Rows |
| --- | ---: |
| Users | 5,000 |
| Projects | 2,000 |
| Project invitations | 50,000 |
| Tasks | 500,000 |
| Task dependencies | 1,000,000 |
| Materials | 20,000 |
| Deliveries | 400,000 |
| Delivery lines | 3,000,000 |

One project has 3,000 tasks. The remaining tasks are distributed across the other projects. The dependency seed contains chains and multiple direct prerequisites while remaining acyclic. Stock balances are derived from the terminal delivery states.

Every seeded account uses `SiteTrackDemo123!`:

| Account | Email | Role |
| --- | --- | --- |
| Demo superadmin | `user0001@sitetrack.example` | `superadmin` |
| Demo company store manager | `user0002@sitetrack.example` | `company_store_manager` |
| Demo user | `user0003@sitetrack.example` | `user` |

The credentials and data are test-only.

## API map

All routes except `/health`, `/docs`, `/openapi.yaml`, `/auth/register`, and `/auth/login` require `Authorization: Bearer <token>`. Errors use `{ "error": { "code": "...", "message": "..." } }`. Lists accept `page` (default 1) and `limit` (default 50, max 100) where shown in the OpenAPI spec.

| Area | Routes |
| --- | --- |
| Authentication | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/users/{userId}/role` |
| Notifications | `GET /notifications`, `POST /notifications/read`, `POST /notifications/{invitationId}/respond` |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{projectId}`, `GET /projects/{projectId}/members` |
| Membership | `GET/POST /projects/{projectId}/invitations`, `DELETE /projects/{projectId}/invitations/{invitationId}`, `GET /projects/{projectId}/members`, `PATCH /projects/{projectId}/members/{userId}/admin`, `DELETE /projects/{projectId}/members/{userId}` |
| Tasks | `GET/POST /projects/{projectId}/tasks`, `GET/PATCH/DELETE /projects/{projectId}/tasks/{taskId}`, `PUT /projects/{projectId}/tasks/{taskId}/dependencies`, `POST /projects/{projectId}/tasks/{taskId}/actions/{start\|done\|reopen}` |
| Materials | `GET/POST /materials`, `PATCH/DELETE /materials/{materialId}` |
| Project store | `GET /projects/{projectId}/store` |
| Project deliveries | `GET/POST /projects/{projectId}/deliveries` |
| Company store | `GET /company-store/stock`, `POST /company-store/stock/{materialId}/add`, `PUT /company-store/stock/{materialId}/reorder-point` |
| Company deliveries | `GET/POST /company-store/deliveries` |
| Delivery actions | `POST /deliveries/{deliveryId}/{record\|reject\|cancel}` |

Request and response fields, list filters, enums, status codes, and role notes are in [`docs/openapi.yaml`](docs/openapi.yaml).

## Design decisions

- **PostgreSQL and parameterized SQL.** Raw SQL keeps important access checks and query plans visible. The schema has indexes for project membership, task lookup in both dependency directions, catalogue search, store stock, and delivery history. `pg_trgm` GIN indexes support substring searches by name. Project task counts are cached and refreshed in the same transaction as task state changes, keeping project summaries fast without serving stale counts.
- **Authorization is checked on every request.** JWTs identify a session, while the API reads current account role and session revocation state from PostgreSQL. Project membership is also queried on each project request. Unauthorized project IDs return the same 404 as missing projects. Company-store routes are limited to store managers and superadmins.
- **Session and password handling.** Passwords are scrypt hashes. A JWT is valid for 30 days by default and carries a session ID. Logout revokes that row, so the token stops working immediately. Role and membership updates are visible on the next request.
- **Registration role behavior.** The assignment says registrants choose an app role, so the API accepts `user`, `company_store_manager`, or `superadmin` at registration. A public production product should restrict elevated role assignment to a trusted provisioning flow.
- **Stable public IDs.** Project IDs come from a non-reused PostgreSQL identity sequence. Task numbers are allocated by a row-locked per-project counter. Removing a project or task soft-deletes it; task deletion also removes dependency edges, while the counter keeps increasing.
- **Task dependency graph.** Composite foreign keys prevent cross-project edges. Dependency replacement locks the project while it checks for cycles and writes the new edge set. Recursive CTEs find reachable prerequisites and dependents; breadth-first traversal calculates shortest distances without enumerating every possible graph path. Status transitions use recursive reachability checks and dedicated actions.
- **Derived flags.** Late and Blocked are computed from dates, statuses, and dependencies. They are not stored as user-editable values. For valid task states, checking direct prerequisites in the list query is sufficient because start and reopen actions preserve the dependency invariant; detail views use the full transitive graph.
- **Atomic stock movement.** A delivery header and immutable material lines are created in one transaction. The sender's balances are locked in consistent store/material order and decremented only if enough stock remains. Receiving adds stock. Rejecting or cancelling returns stock to the sender. A database trigger rejects company-to-company and project-to-project delivery routes.
- **Pagination.** List routes use bounded page/limit offset pagination. Empty pages preserve the filtered total and notification unread count. This is simple for the frontend and works well for the first pages used by the screens. Very deep pages in the 400,000-delivery company history are a future candidate for cursor pagination if measurements show a need.
- **Migration and seed workflows.** Migrations run before the API starts. The full seed uses an extended statement timeout inside its one-time transaction; the API request pool keeps a 30-second statement timeout.

## Tests and performance checks

The integration tests are destructive to their configured database. Use a disposable database named `sitetrack_test`, never the demo database:

```bash
docker compose exec -T db createdb -U sitetrack sitetrack_test
docker compose exec -T -e DATABASE_URL=postgres://sitetrack:sitetrack@db:5432/sitetrack_test api node dist/db/migrate.js
DATABASE_URL=postgres://sitetrack:sitetrack@localhost:5432/sitetrack_test JWT_SECRET=test-secret-for-integration-suite-32chars npm test
```

The suite checks session revocation, uniform login failures, hidden projects, invitation acceptance, immediate membership removal, last-admin protection, task ID allocation, dependency cycle and status rules, shortest dependency distances, cached project counts, exact decimal delivery quantities, stock overflow validation, concurrent stock sends, concurrent delivery recording, and store access.

After loading demo data, run the read-only benchmark inside the API container:

```bash
docker compose exec -T api node scripts/benchmark.mjs
```

It warms each route, then reports request count, failures, p50, p95, and maximum latency for representative first-page queries from all major screens. Tune request count, concurrency, and request timeout with `REQUESTS_PER_ROUTE`, `CONCURRENCY`, and `REQUEST_TIMEOUT_MS`. Set `P95_TARGET_MS` to make the script exit nonzero when a route misses a chosen target. The Compose services are capped at 1 CPU each, with 1 GiB for PostgreSQL and 512 MiB for the API. The brief does not define a latency SLO; record the chosen target with benchmark results.

Benchmark snapshot on 2026-11-13: 20 measured requests per route, concurrency 3, full seeded dataset, and a chosen p95 target of 2,000 ms. All routes completed without failures.

| Route | p95 |
| --- | ---: |
| Project summary | 287 ms |
| Late project summary | 207 ms |
| 3,000-task project list | 8 ms |
| Task detail with transitive graph | 27 ms |
| Project store | 84 ms |
| Project deliveries | 41 ms |
| Project members | 5 ms |
| Material catalogue search | 64 ms |
| Notifications | 51 ms |
| Company stock | 1,598 ms |
| Company delivery history | 819 ms |
