/**
 * Exercises late schema-bearing plugin registration against a real isolated
 * PGlite database, including the inbox migration service's startup query.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  type JsonValue,
  stringToUuid,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { INBOX_MIGRATION_SERVICE_TYPE } from "../../../../plugins/plugin-inbox/src/inbox/migration.ts";
import { inboxPlugin } from "../../../../plugins/plugin-inbox/src/plugin.ts";
import { RuntimeMigrator } from "../../../../plugins/plugin-sql/src/runtime-migrator/runtime-migrator.ts";
import * as sqlSchema from "../../../../plugins/plugin-sql/src/schema/index.ts";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle.ts";

const CONCURRENT_SCHEMA_PLUGIN = "concurrent-late-schema-plugin";
const concurrentSchema = pgSchema("app_concurrent_late");
const concurrentProbeTable = concurrentSchema.table("probe", {
  value: text("value").notNull(),
});

class PGliteMigrationAdapter extends InMemoryDatabaseAdapter {
  readonly pglite: PGlite;
  readonly pgliteDb: PgliteDatabase;
  activeMigrations = 0;
  maxConcurrentMigrations = 0;

  constructor(dataDir: string) {
    super();
    this.pglite = new PGlite(dataDir, { extensions: { vector } });
    this.pgliteDb = drizzle(this.pglite);
    Object.defineProperty(this.db, "execute", {
      value: this.pgliteDb.execute.bind(this.pgliteDb),
    });
  }

  override async initialize(): Promise<void> {
    await this.pglite.waitReady;
    await super.initialize();
  }

  override async runPluginMigrations(
    plugins: Array<{
      name: string;
      schema?: Record<string, JsonValue | object>;
    }> = [],
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    },
  ): Promise<void> {
    this.activeMigrations += 1;
    this.maxConcurrentMigrations = Math.max(
      this.maxConcurrentMigrations,
      this.activeMigrations,
    );
    try {
      const migrator = new RuntimeMigrator(this.pgliteDb);
      for (const plugin of plugins) {
        if (plugin.schema) {
          await migrator.migrate(plugin.name, plugin.schema, options);
        }
      }
    } finally {
      this.activeMigrations -= 1;
    }
  }

  override async close(): Promise<void> {
    await super.close();
    await this.pglite.close();
  }
}

describe("late plugin schema ordering", () => {
  let runtime: AgentRuntime | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    if (runtime) {
      if (
        runtime.plugins.some(
          (plugin) => plugin.name === "@elizaos/plugin-inbox",
        )
      ) {
        await runtime.unloadPlugin("@elizaos/plugin-inbox");
      }
      if (
        runtime.plugins.some(
          (plugin) => plugin.name === CONCURRENT_SCHEMA_PLUGIN,
        )
      ) {
        await runtime.unloadPlugin(CONCURRENT_SCHEMA_PLUGIN);
      }
      await runtime.stop();
      await runtime.close();
      runtime = null;
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it("materializes app_inbox before starting InboxMigrationService", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "eliza-late-schema-"));
    const agentId = stringToUuid("late-schema-integration");
    const character = createCharacter({
      id: agentId,
      name: "LateSchemaIntegration",
    });
    const adapter = new PGliteMigrationAdapter(dataDir);
    await adapter.initialize();

    runtime = new AgentRuntime({
      character,
      adapter,
      logLevel: "fatal",
    });
    await runtime.registerPlugin({
      name: "@elizaos/plugin-sql",
      description: "Real SQL schema for the isolated PGlite runtime.",
      schema: sqlSchema,
    });
    await runtime.initialize();
    installRuntimePluginLifecycle(runtime);

    await runtime.registerPlugin(inboxPlugin);
    await runtime.getServiceLoadPromise(INBOX_MIGRATION_SERVICE_TYPE);

    const tableRows = await adapter.pgliteDb.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'app_inbox'
      ORDER BY table_name
    `);
    expect(tableRows.rows.map((row) => row.table_name)).toEqual([
      "life_email_unsubscribes",
      "life_inbox_triage_entries",
      "life_inbox_triage_examples",
    ]);
    expect(
      runtime.getServiceRegistrationStatus(INBOX_MIGRATION_SERVICE_TYPE),
    ).toBe("registered");
    expect(
      runtime
        .getRecentReportedErrors()
        .filter((entry) => entry.scope === "AgentRuntime.serviceStart"),
    ).toEqual([]);
  });

  it("serializes concurrent late schema migrations on one adapter", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "eliza-late-schema-queue-"));
    const adapter = new PGliteMigrationAdapter(dataDir);
    await adapter.initialize();
    runtime = new AgentRuntime({
      character: createCharacter({ name: "ConcurrentLateSchemaIntegration" }),
      adapter,
      logLevel: "fatal",
    });
    await runtime.registerPlugin({
      name: "@elizaos/plugin-sql",
      description: "Real SQL schema for the isolated PGlite runtime.",
      schema: sqlSchema,
    });
    await runtime.initialize();
    installRuntimePluginLifecycle(runtime);

    await Promise.all([
      runtime.registerPlugin(inboxPlugin),
      runtime.registerPlugin({
        name: CONCURRENT_SCHEMA_PLUGIN,
        description: "Concurrent migration ordering probe.",
        schema: { concurrentProbeTable },
      }),
    ]);
    await runtime.getServiceLoadPromise(INBOX_MIGRATION_SERVICE_TYPE);

    const tableRows = await adapter.pgliteDb.execute(sql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE (table_schema = 'app_inbox' AND table_name = 'life_inbox_triage_entries')
         OR (table_schema = 'app_concurrent_late' AND table_name = 'probe')
      ORDER BY table_schema, table_name
    `);
    expect(tableRows.rows).toEqual([
      {
        table_schema: "app_concurrent_late",
        table_name: "probe",
      },
      {
        table_schema: "app_inbox",
        table_name: "life_inbox_triage_entries",
      },
    ]);
    expect(adapter.maxConcurrentMigrations).toBe(1);
  });
});
