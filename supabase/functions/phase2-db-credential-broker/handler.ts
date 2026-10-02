import { bootstrap, cleanup, type Database, finalize } from "./database.ts";
import {
  CI,
  connectionUrls,
  Denied,
  record,
  requireCondition,
  verifyOidc,
} from "./security.ts";

export function createHandler(
  connect: () => Promise<Database>,
  fetcher: typeof fetch = fetch,
) {
  return async (request: Request): Promise<Response> => {
    let database: Database | undefined;
    try {
      requireCondition(request.method === "POST");
      const authorization = request.headers.get("authorization") ?? "";
      requireCondition(
        authorization.startsWith("Bearer ") && authorization.length <= 16_400,
      );
      await verifyOidc(authorization.slice(7), fetcher);
      requireCondition(
        request.headers.get("content-type")?.split(";")[0] ===
          "application/json",
      );
      const reader = request.body?.getReader();
      requireCondition(reader);
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          requireCondition(length <= 1024);
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body = record(
        JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
          ),
        ),
      );
      requireCondition(
        Object.keys(body).every((key) =>
          ["action", "role", "secret"].includes(key)
        ),
      );
      requireCondition(
        body.action === "bootstrap" || body.action === "cleanup" ||
          body.action === "finalize",
      );
      requireCondition(body.action !== "bootstrap" || body.role === undefined);
      requireCondition(body.action === "finalize" || body.secret === undefined);
      // Targets are fixed even for finalization; reject arbitrary names before
      // connecting. OIDC run/attempt validation remains mandatory for all actions.
      requireCondition(body.role === undefined || body.role === CI.role);
      requireCondition(body.secret === undefined || body.secret === CI.secret);
      database = await connect();
      if (body.action === "cleanup") {
        await cleanup(database, body.role);
        return Response.json({ cleaned: true }, {
          headers: { "cache-control": "no-store" },
        });
      }
      if (body.action === "finalize") {
        await finalize(database, body.role, body.secret);
        return Response.json({ finalized: true }, {
          headers: { "cache-control": "no-store" },
        });
      }
      const credential = await bootstrap(database);
      return Response.json(
        {
          role: credential.role,
          credentialLifecycle: "phase2-vault-v1",
          directCredentialVerified: true,
          ...connectionUrls(credential.role, credential.password),
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      // Never forward exception messages, JWTs, URLs, passwords or SQL to logs.
      return Response.json({ error: "request_denied" }, {
        status: error instanceof Denied ? 403 : 503,
        headers: { "cache-control": "no-store" },
      });
    } finally {
      if (database) await database.close().catch(() => undefined);
    }
  };
}
