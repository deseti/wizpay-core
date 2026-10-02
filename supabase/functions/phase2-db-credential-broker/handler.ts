import { bootstrap, cleanup, type Database } from "./database.ts";
import {
  connectionUrls,
  Denied,
  randomPassword,
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
      const identity = await verifyOidc(authorization.slice(7), fetcher);
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
        Object.keys(body).every((key) => ["action", "role"].includes(key)),
      );
      requireCondition(
        body.action === "bootstrap" || body.action === "cleanup",
      );
      requireCondition(body.action === "cleanup" || body.role === undefined);
      // Reject arbitrary cleanup identities before opening a database connection.
      if (body.action === "cleanup" && body.role !== undefined) {
        const expected = `wizpay_p2_${identity.runId}_${identity.attempt}`;
        requireCondition(body.role === expected);
      }
      database = await connect();
      if (body.action === "cleanup") {
        await cleanup(database, identity, body.role);
        return Response.json({ cleaned: true }, {
          headers: { "cache-control": "no-store" },
        });
      }
      const password = randomPassword();
      const role = await bootstrap(database, identity, password);
      try {
        await database.verifyCredentials(role.role, password);
      } catch {
        // Commit NOLOGIN/password removal before bounded ownership cleanup.
        // Never return credentials, even if termination/drop also fails.
        await cleanup(database, identity, role.role);
        throw new Error("Direct credential verification failed");
      }
      return Response.json(
        {
          ...role,
          directCredentialVerified: true,
          ...connectionUrls(role.role, password),
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
