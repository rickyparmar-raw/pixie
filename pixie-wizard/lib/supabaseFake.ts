// Shared in-memory double for the Supabase client in tests. Every test file
// needing @/lib/supabase MUST register this same factory via mock.module —
// bun applies module mocks process-wide, so two files with different shapes
// silently clobber each other (the railway.test.ts lesson). One factory,
// enforced primary-key/unique behavior for the hosted tables, zero network.
type Row = Record<string, unknown>;

interface Filter {
  col: string;
  op: "eq" | "in";
  value: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.value;
    return Array.isArray(f.value) && (f.value as unknown[]).includes(row[f.col]);
  });
}

export interface SupabaseFake {
  db: { from: (table: string) => QueryBuilder };
  tables: Record<string, Row[]>;
}

export interface QueryBuilder {
  select: (...args: unknown[]) => QueryBuilder;
  insert: (values: unknown) => QueryBuilder;
  update: (values: unknown) => QueryBuilder;
  delete: () => QueryBuilder;
  eq: (col: string, value: unknown) => QueryBuilder;
  in: (col: string, values: unknown[]) => QueryBuilder;
  order: (...args: unknown[]) => QueryBuilder;
  limit: (...args: unknown[]) => QueryBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error?: { code: string } }>;
  single: () => Promise<{ data: Row | null; error?: { code: string; message: string } }>;
  then?: unknown;
}

export function createSupabaseFake(seed: Record<string, Row[]> = {}): SupabaseFake {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = [...v];

  function rowsOf(table: string): Row[] {
    if (!tables[table]) tables[table] = [];
    return tables[table];
  }

  // Uniqueness rules mirroring the real migrations.
  function conflict(table: string, row: Row): boolean {
    if (table === "hosted_program_channels") {
      return rowsOf(table).some((r) => r.workspace_id === row.workspace_id && r.channel_id === row.channel_id);
    }
    if (table === "hosted_programs") {
      return rowsOf(table).some(
        (r) => r.workspace_id === row.workspace_id && r.id === row.id && (r.status ?? "active") === "active",
      );
    }
    return false;
  }

  const db = {
    from(table: string): QueryBuilder {
      const filters: Filter[] = [];
      let pendingInsert: Row | null = null;
      let pendingUpdate: Row | null = null;
      let isDelete = false;

      function runInsert(): { data: Row | null; error?: { code: string; message?: string } } {
        if (!pendingInsert) return { data: null };
        if (conflict(table, pendingInsert)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const row = { ...pendingInsert };
        rowsOf(table).push(row);
        return { data: row };
      }

      function runUpdate(): { data: null } {
        if (pendingUpdate) {
          for (const r of rowsOf(table)) {
            if (matches(r, filters)) Object.assign(r, pendingUpdate);
          }
        }
        return { data: null };
      }

      function runDelete(): { data: null } {
        if (isDelete) {
          tables[table] = rowsOf(table).filter((r) => !matches(r, filters));
        }
        return { data: null };
      }

      const builder = {
        select: () => builder,
        insert: (values: unknown) => {
          pendingInsert = values as Row;
          return builder;
        },
        update: (values: unknown) => {
          pendingUpdate = values as Row;
          return builder;
        },
        delete: () => {
          isDelete = true;
          return builder;
        },
        eq: (col: string, value: unknown) => {
          filters.push({ col, op: "eq", value });
          return builder;
        },
        in: (col: string, values: unknown[]) => {
          filters.push({ col, op: "in", value: values });
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (pendingInsert) return runInsert();
          if (pendingUpdate) return runUpdate();
          if (isDelete) return runDelete();
          return { data: rowsOf(table).find((r) => matches(r, filters)) ?? null };
        },
        single: async () => {
          if (pendingInsert) {
            const res = runInsert();
            if (res.error) return res;
            const row = { ...(res.data as Row), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            Object.assign(res.data as Row, { created_at: row.created_at, updated_at: row.updated_at });
            return { data: row };
          }
          const found = rowsOf(table).find((r) => matches(r, filters)) ?? null;
          if (!found) return { data: null, error: { code: "PGRST116", message: "no rows" } };
          return { data: found };
        },
        // postgrest-js builders are thenable: bare `await insert(...)` executes.
        then: (resolve: (v: { data: null; error?: { code: string } }) => void) => {
          if (pendingInsert) resolve(runInsert());
          else if (pendingUpdate) resolve(runUpdate());
          else if (isDelete) resolve(runDelete());
          else resolve({ data: null });
          return Promise.resolve({ data: null });
        },
      } as QueryBuilder;
      return builder;
    },
  };
  return { db, tables };
}
