// Test-only stub for Railway's GraphQL API. railway.ts funnels every call
// through one global fetch POST, so tests script canned payloads per mutation
// name instead of mock.module(), which poisons the module registry for the
// whole bun test process and broke railway.test.ts in full-suite runs.
export interface RecordedCall {
  mutation: string;
  variables: Record<string, unknown>;
}

const MUTATIONS = [
  "projectCreate",
  "serviceCreate",
  "variableCollectionUpsert",
  "volumeCreate",
  "environmentTriggersDeploy",
  "deployments",
  "serviceInstanceUpdate",
  "projectDelete",
] as const;

export type MutationName = (typeof MUTATIONS)[number];

function mutationOf(query: string): MutationName | "unknown" {
  for (const m of MUTATIONS) {
    if (query.includes(m)) return m;
  }
  return "unknown";
}

export interface RailwayStub {
  calls: RecordedCall[];
  callsOf: (mutation: MutationName) => RecordedCall[];
  failOn: (mutation: MutationName, message: string) => void;
  setDeployEdges: (edges: Array<{ node: { id: string; status: string } }>) => void;
  restore: () => void;
}

export function installRailwayStub(): RailwayStub {
  const realFetch = global.fetch;
  const calls: RecordedCall[] = [];
  const failures = new Map<MutationName, string>();
  let deployEdges: Array<{ node: { id: string; status: string } }> = [];

  global.fetch = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String((init?.body as string) ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const mutation = mutationOf(parsed.query ?? "");
    calls.push({ mutation: mutation as string, variables: parsed.variables ?? {} });

    const failure = failures.get(mutation as MutationName);
    if (failure) {
      return new Response(JSON.stringify({ errors: [{ message: failure }] }));
    }
    switch (mutation) {
      case "projectCreate":
        return new Response(JSON.stringify({ data: { projectCreate: { id: "p1", baseEnvironmentId: "e1" } } }));
      case "serviceCreate":
        return new Response(JSON.stringify({ data: { serviceCreate: { id: "s1" } } }));
      case "variableCollectionUpsert":
        return new Response(JSON.stringify({ data: { variableCollectionUpsert: true } }));
      case "volumeCreate":
        return new Response(JSON.stringify({ data: { volumeCreate: { id: "vol1" } } }));
      case "environmentTriggersDeploy":
        return new Response(JSON.stringify({ data: { environmentTriggersDeploy: true } }));
      case "deployments":
        return new Response(JSON.stringify({ data: { deployments: { edges: deployEdges } } }));
      case "serviceInstanceUpdate":
        return new Response(JSON.stringify({ data: { serviceInstanceUpdate: true } }));
      case "projectDelete":
        return new Response(JSON.stringify({ data: { projectDelete: true } }));
      default:
        return new Response(JSON.stringify({ errors: [{ message: `unexpected query: ${parsed.query}` }] }));
    }
  }) as typeof fetch;

  return {
    calls,
    callsOf: (mutation) => calls.filter((c) => c.mutation === mutation),
    failOn: (mutation, message) => {
      failures.set(mutation, message);
    },
    setDeployEdges: (edges) => {
      deployEdges = edges;
    },
    restore: () => {
      global.fetch = realFetch;
    },
  };
}
