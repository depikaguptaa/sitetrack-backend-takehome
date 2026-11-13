import { performance } from "node:perf_hooks";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const requestsPerRoute = Math.max(1, Number(process.env.REQUESTS_PER_ROUTE ?? 20));
const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 5));
const timeoutMs = Math.max(1, Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000));
const p95Target = process.env.P95_TARGET_MS ? Number(process.env.P95_TARGET_MS) : undefined;

async function login(email) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "SiteTrackDemo123!" }),
  });
  if (!response.ok) throw new Error(`Login failed for ${email}: HTTP ${response.status}`);
  return (await response.json()).accessToken;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

async function measure(route, token) {
  const headers = { authorization: `Bearer ${token}` };
  const run = async () => {
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}${route}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      await response.arrayBuffer();
      return { status: response.status, elapsed: performance.now() - started };
    } catch (error) {
      return { status: 0, elapsed: performance.now() - started, error: String(error).slice(0, 200) };
    }
  };

  for (let i = 0; i < Math.min(2, requestsPerRoute); i += 1) await run();
  const samples = [];
  let next = 0;
  async function worker() {
    while (next < requestsPerRoute) {
      const index = next++;
      samples[index] = await run();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requestsPerRoute) }, worker));
  const latencies = samples.map((sample) => sample.elapsed).sort((a, b) => a - b);
  const failures = samples.filter((sample) => sample.status !== 200).length;
  const result = { route, requests: requestsPerRoute, concurrency, failures, p50Ms: Math.round(percentile(latencies, 0.5)), p95Ms: Math.round(percentile(latencies, 0.95)), maxMs: Math.round(latencies.at(-1) ?? 0), errors: [...new Set(samples.map((sample) => sample.error).filter(Boolean))] };
  console.log(JSON.stringify(result));
  if (failures || (p95Target !== undefined && result.p95Ms > p95Target)) process.exitCode = 1;
}

const [superadminToken, managerToken] = await Promise.all([
  login("user0001@sitetrack.example"),
  login("user0002@sitetrack.example"),
]);

const workloads = [
  ["/projects?limit=50&sort=percentageDone", superadminToken],
  ["/projects?limit=50&lateOnly=true&sort=lateTasks", superadminToken],
  ["/projects/PRJ-0001/tasks?limit=50&sort=dependentCount", superadminToken],
  ["/projects/PRJ-0001/tasks/PRJ-0001-T-0125", superadminToken],
  ["/projects/PRJ-0001/store?limit=50&sort=quantity", superadminToken],
  ["/projects/PRJ-0001/deliveries?limit=50", superadminToken],
  ["/projects/PRJ-0001/members?limit=50", superadminToken],
  ["/materials?limit=50&search=Cement", superadminToken],
  ["/notifications?limit=50", superadminToken],
  ["/company-store/stock?limit=50&sort=status", managerToken],
  ["/company-store/deliveries?limit=50&status=delivered", managerToken],
];

for (const [route, token] of workloads) await measure(route, token);
