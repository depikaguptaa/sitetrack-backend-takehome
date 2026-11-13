import pg, { type PoolClient, type QueryResultRow } from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://sitetrack:sitetrack@localhost:5432/sitetrack",
  max: Number(process.env.PGPOOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  return pool.query<T>(text, values);
}

export async function queryPage<T extends QueryResultRow>(
  text: string,
  values: unknown[],
  limitIndex: number,
  offsetIndex: number,
) {
  const result = await query<T>(text, values);
  const row = result.rows[0];
  const offset = Number(values[offsetIndex]);
  if (row || offset === 0) {
    return { result, total: Number(row?.total_count ?? 0), metadataRow: row };
  }

  const firstPageValues = [...values];
  firstPageValues[limitIndex] = 1;
  firstPageValues[offsetIndex] = 0;
  const firstPage = await query<T>(text, firstPageValues);
  const metadataRow = firstPage.rows[0];
  return {
    result,
    total: Number(metadataRow?.total_count ?? 0),
    metadataRow,
  };
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
