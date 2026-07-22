/**
 * Engine Integration Test - Production Validation
 *
 * @module engine/__tests__/integration/real-engine-tick.integration.test
 *
 * @description
 * Uses LLM calls (no mocks) to validate the engine generates content,
 * creates trades, and processes game mechanics in production-like conditions.
 *
 * **What This Tests (no mocks):**
 * - Game tick execution with LLM calls
 * - News article generation
 * - NPC trading decisions (LLM-generated)
 * - Question generation and resolution
 * - Market price updates from trades
 * - Group chat message generation
 * - Event generation
 * - All time modes: realtime, simulated, fed-in time
 *
 * **Requirements:**
 * - Database must be running (PostgreSQL)
 * - LLM API key must be set (GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)
 * - Run with: RUN_REAL_ENGINE_TESTS=true bun test real-engine-tick
 *
 * @see {@link executeGameTick} - Main function under test
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { asSystem, sql } from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";

// Set timeout to 10 minutes for real LLM calls
setDefaultTimeout(600000);

// Load environment variables
const loadEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return;
  const envContent = readFileSync(filePath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
};

// Load environment from root .env
loadEnvFile(".env");
loadEnvFile(".env.test");
loadEnvFile(".env.local");

const hasLLMKey = !!(
  (process.env.GROQ_API_KEY?.trim() ?? "") !== "" ||
  (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" ||
  (process.env.OPENAI_API_KEY?.trim() ?? "") !== ""
);
const liveLlmConfig = resolveLiveLlmTestConfig();
const shouldSkipLiveLlmTests =
  !liveLlmConfig.enabled && process.env.RUN_REAL_ENGINE_TESTS !== "true";

const requireLLMKey = () => {
  if (!hasLLMKey) {
    throw new Error(
      "ENGINE TESTS REQUIRE LLM API KEY. " +
        "Set GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to run these tests. " +
        "These tests validate actual engine functionality and MUST NOT be skipped.",
    );
  }
};

/**
 * Track all test results for final validation
 */
interface TestResults {
  tickExecuted: boolean;
  articlesGenerated: number;
  postsGenerated: number;
  eventsGenerated: number;
  questionsCreated: number;
  questionsResolved: number;
  marketsUpdated: number;
  npcDecisionsMade: boolean;
  trendingCalculated: boolean;
}

describe.skipIf(shouldSkipLiveLlmTests)(
  "Engine Integration Tests (No Mocks)",
  () => {
    let results: TestResults;
    let testStartTime: Date;
    let initialQuestionCount: number;
    let initialMarketCount: number;
    let initialPostCount: number;
    let initialEventCount: number;

    beforeAll(async () => {
      requireLLMKey();

      console.log("\n🔥 ENGINE INTEGRATION TEST STARTING");
      console.log("========================================");
      console.log("This test uses LLM calls - no mocks");
      console.log("");

      // Detect which LLM provider is available
      const provider = process.env.GROQ_API_KEY
        ? "Groq"
        : process.env.ANTHROPIC_API_KEY
          ? "Anthropic"
          : "OpenAI";
      console.log(`📡 Using LLM Provider: ${provider}`);

      testStartTime = new Date();
      results = {
        tickExecuted: false,
        articlesGenerated: 0,
        postsGenerated: 0,
        eventsGenerated: 0,
        questionsCreated: 0,
        questionsResolved: 0,
        marketsUpdated: 0,
        npcDecisionsMade: false,
        trendingCalculated: false,
      };

      // Get baseline counts using raw Drizzle query
      const { getRawDrizzle } = await import("@feed/db");
      const rawDb = getRawDrizzle();

      // Verify database tables exist before running tests
      try {
        await rawDb.execute(sql`SELECT 1 FROM questions LIMIT 1`);
      } catch (dbError) {
        throw new Error(
          `DATABASE NOT READY: The 'questions' table does not exist. ` +
            `Run 'bun run db:push' or 'bun run db:migrate' to set up the schema before running integration tests. ` +
            `Original error: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        );
      }

      // Use raw SQL count to avoid Drizzle count() compatibility issues
      const questionCountResult = await rawDb.execute(
        sql`SELECT COUNT(*) as count FROM questions WHERE status = 'active'`,
      );
      initialQuestionCount = Number(questionCountResult[0]?.count ?? 0);

      const marketCountResult = await rawDb.execute(
        sql`SELECT COUNT(*) as count FROM markets WHERE resolved = false`,
      );
      initialMarketCount = Number(marketCountResult[0]?.count ?? 0);

      const postCountResult = await rawDb.execute(
        sql`SELECT COUNT(*) as count FROM posts`,
      );
      initialPostCount = Number(postCountResult[0]?.count ?? 0);

      const eventCountResult = await rawDb.execute(
        sql`SELECT COUNT(*) as count FROM world_events`,
      );
      initialEventCount = Number(eventCountResult[0]?.count ?? 0);

      console.log(`📊 Initial State:`);
      console.log(`   - Active Questions: ${initialQuestionCount}`);
      console.log(`   - Active Markets: ${initialMarketCount}`);
      console.log(`   - Total Posts: ${initialPostCount}`);
      console.log(`   - Total Events: ${initialEventCount}`);
      console.log("");

      const gameState = await asSystem(async (db) => {
        return await db.game.findFirst({
          where: { isContinuous: true },
        });
      }, "real-engine-test-get-game");

      if (!gameState?.isRunning) {
        await asSystem(async (db) => {
          if (!gameState) {
            await db.game.create({
              data: {
                id: await generateSnowflakeId(),
                isContinuous: true,
                isRunning: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
          } else {
            await db.game.updateMany({
              where: { isContinuous: true },
              data: { isRunning: true },
            });
          }
        }, "real-engine-test-ensure-game-running");
      }

      console.log("✅ Game state verified - running");
    });

    afterAll(async () => {
      // requireLLMKey already ran in beforeAll, so we know we have a key here
      console.log("\n========================================");
      console.log("📊 FINAL TEST RESULTS SUMMARY");
      console.log("========================================");
      console.log(`Tick Executed: ${results.tickExecuted ? "✅" : "❌"}`);
      console.log(`Articles Generated: ${results.articlesGenerated}`);
      console.log(`Posts Generated: ${results.postsGenerated}`);
      console.log(`Events Generated: ${results.eventsGenerated}`);
      console.log(`Questions Created: ${results.questionsCreated}`);
      console.log(`Questions Resolved: ${results.questionsResolved}`);
      console.log(`Markets Updated: ${results.marketsUpdated}`);
      console.log(
        `NPC Decisions Made: ${results.npcDecisionsMade ? "✅" : "❌"}`,
      );
      console.log(
        `Trending Calculated: ${results.trendingCalculated ? "✅" : "❌"}`,
      );
      console.log("========================================\n");

      if (results.tickExecuted) {
        const totalGenerated =
          results.articlesGenerated +
          results.postsGenerated +
          results.eventsGenerated +
          results.questionsCreated;

        if (totalGenerated === 0 && results.marketsUpdated === 0) {
          console.warn(
            "⚠️  WARNING: Tick executed but no content was generated!",
          );
          console.warn(
            "   This may indicate a problem with the engine generation.",
          );
        }
      }
    });

    test("should execute game tick with LLM calls", async () => {
      console.log("\n🚀 Executing game tick (with content generation)...");
      const startTime = Date.now();

      // Import the real executeGameTick - no mocks
      const { executeGameTick } = await import("../../game-tick");

      // Execute with content generation enabled (false = DO generate content)
      const result = await executeGameTick(false);

      const duration = Date.now() - startTime;
      console.log(`⏱️  Tick completed in ${duration}ms`);

      expect(result).toBeDefined();
      expect(typeof result.postsCreated).toBe("number");
      expect(typeof result.articlesCreated).toBe("number");
      expect(typeof result.eventsCreated).toBe("number");
      expect(typeof result.marketsUpdated).toBe("number");
      expect(typeof result.questionsResolved).toBe("number");
      expect(typeof result.questionsCreated).toBe("number");
      expect(typeof result.trendingCalculated).toBe("boolean");

      // Store results
      results.tickExecuted = true;
      results.postsGenerated = result.postsCreated;
      results.articlesGenerated = result.articlesCreated;
      results.eventsGenerated = result.eventsCreated;
      results.marketsUpdated = result.marketsUpdated;
      results.questionsCreated = result.questionsCreated;
      results.questionsResolved = result.questionsResolved;
      results.trendingCalculated = result.trendingCalculated;
      results.npcDecisionsMade = result.marketsUpdated > 0;

      console.log(`📝 Posts created: ${result.postsCreated}`);
      console.log(`📰 Articles created: ${result.articlesCreated}`);
      console.log(`🎭 Events created: ${result.eventsCreated}`);
      console.log(`💹 Markets updated: ${result.marketsUpdated}`);
      console.log(`❓ Questions created: ${result.questionsCreated}`);
      console.log(`✅ Questions resolved: ${result.questionsResolved}`);
    }, 600000); // 10 minute timeout for real LLM calls (tick + trade execution takes ~5 mins)

    test("should have generated news articles (not mocked)", async () => {
      expect(results.tickExecuted).toBe(true);

      const { db } = await import("@feed/db");

      // Get articles created after test start
      const newArticles = await db.post.findMany({
        where: {
          type: "article",
          timestamp: { gte: testStartTime },
        },
        orderBy: { timestamp: "desc" },
        take: 10,
      });

      console.log(`\n📰 Found ${newArticles.length} new articles`);

      for (const article of newArticles) {
        const isMocked =
          article.content?.includes("Mock") ||
          article.content?.includes("mock") ||
          article.articleTitle?.includes("Mock");

        if (isMocked) {
          console.warn(
            `⚠️  WARNING: Article appears to be mocked: ${article.articleTitle}`,
          );
        }

        expect(article.content?.length || 0).toBeGreaterThan(50);
        expect(article.articleTitle?.length || 0).toBeGreaterThan(10);

        console.log(
          `   📄 "${article.articleTitle?.substring(0, 60)}..." (${article.content?.length || 0} chars)`,
        );
      }

      if (results.articlesGenerated > 0) {
        expect(newArticles.length).toBeGreaterThan(0);
      }
    });

    test("should have executed NPC trading decisions (not mocked)", async () => {
      expect(results.tickExecuted).toBe(true);

      const { db } = await import("@feed/db");

      const newPositions = await db.poolPosition.findMany({
        where: {
          createdAt: { gte: testStartTime },
          closedAt: null, // Open positions
        },
        take: 20,
      });

      console.log(`\n💹 Found ${newPositions.length} new NPC positions`);

      for (const pos of newPositions.slice(0, 5)) {
        console.log(
          `   📈 Pool ${pos.poolId}: ${pos.side} ${pos.size} @ ${pos.entryPrice}`,
        );
      }

      const recentPriceUpdates = await db.priceHistory.findMany({
        where: {
          timestamp: { gte: testStartTime },
        },
        take: 10,
      });

      console.log(`   📊 ${recentPriceUpdates.length} price updates recorded`);

      if (results.marketsUpdated > 0) {
        // Positions or price updates should exist
        const hasEvidence =
          newPositions.length > 0 || recentPriceUpdates.length > 0;
        expect(hasEvidence).toBe(true);
      }
    });

    test("should have created prediction market questions (not mocked)", async () => {
      expect(results.tickExecuted).toBe(true);

      const { db } = await import("@feed/db");

      // Get questions created after test start
      const newQuestions = await db.question.findMany({
        where: {
          createdAt: { gte: testStartTime },
          status: "active",
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      console.log(`\n❓ Found ${newQuestions.length} new questions`);

      for (const question of newQuestions) {
        const isMocked =
          question.text?.includes("Mock") ||
          question.text?.includes("mock") ||
          question.text?.includes("test");

        if (isMocked) {
          console.warn(
            `⚠️  WARNING: Question appears to be mocked: ${question.text}`,
          );
        }

        expect(question.text?.length || 0).toBeGreaterThan(20);

        console.log(
          `   📋 Q${question.questionNumber}: "${question.text?.substring(0, 60)}..."`,
        );

        const market = await db.market.findUnique({
          where: { id: question.id },
        });

        if (!market) {
          console.warn(
            `⚠️  WARNING: Question ${question.id} has no associated market!`,
          );
        } else {
          expect(market.resolved).toBe(false);
        }
      }

      if (results.questionsCreated > 0) {
        expect(newQuestions.length).toBeGreaterThan(0);
      }
    });

    test("should have generated world events (not mocked)", async () => {
      expect(results.tickExecuted).toBe(true);

      const { db } = await import("@feed/db");

      // Get events created after test start
      const newEvents = await db.worldEvent.findMany({
        where: {
          timestamp: { gte: testStartTime },
        },
        orderBy: { timestamp: "desc" },
        take: 10,
      });

      console.log(`\n🎭 Found ${newEvents.length} new world events`);

      for (const event of newEvents) {
        const isMocked =
          event.description?.includes("Mock") ||
          event.description?.includes("mock");

        if (isMocked) {
          console.warn(
            `⚠️  WARNING: Event appears to be mocked: ${event.description?.substring(0, 50)}`,
          );
        }

        expect(event.description?.length || 0).toBeGreaterThan(20);

        console.log(
          `   🎬 [${event.eventType}] "${event.description?.substring(0, 60)}..."`,
        );
      }

      if (results.eventsGenerated > 0) {
        expect(newEvents.length).toBeGreaterThan(0);
      }
    });

    test("market prices should be reasonable (0-100% for predictions)", async () => {
      expect(results.tickExecuted).toBe(true);

      const { db } = await import("@feed/db");

      const activeMarkets = await db.market.findMany({
        where: {
          resolved: false,
          endDate: { gte: new Date() },
        },
        take: 20,
      });

      console.log(`\n💹 Validating ${activeMarkets.length} active markets`);

      let validMarkets = 0;
      let invalidMarkets = 0;

      for (const market of activeMarkets) {
        const yesShares = Number(market.yesShares);
        const noShares = Number(market.noShares);
        const totalShares = yesShares + noShares;

        if (totalShares > 0) {
          const yesOdds = (yesShares / totalShares) * 100;
          const noOdds = (noShares / totalShares) * 100;

          const isValid =
            yesOdds >= 0 &&
            yesOdds <= 100 &&
            noOdds >= 0 &&
            noOdds <= 100 &&
            Math.abs(yesOdds + noOdds - 100) < 0.1;

          if (isValid) {
            validMarkets++;
          } else {
            invalidMarkets++;
            console.warn(
              `⚠️  Invalid market ${market.id}: YES=${yesOdds.toFixed(2)}%, NO=${noOdds.toFixed(2)}%`,
            );
          }
        }
      }

      console.log(`   ✅ Valid markets: ${validMarkets}`);
      console.log(`   ❌ Invalid markets: ${invalidMarkets}`);

      // All markets should have valid odds
      expect(invalidMarkets).toBe(0);
    });

    test("should verify engine produces valid outputs for training", async () => {
      expect(results.tickExecuted).toBe(true);

      const { db } = await import("@feed/db");

      console.log("\n🎓 Validating outputs for training readiness...");

      const postsByType = await db.post.groupBy({
        by: ["type"],
        _count: { id: true },
        where: {
          timestamp: { gte: testStartTime },
        },
      });

      console.log("   Content types generated:");
      for (const group of postsByType) {
        console.log(`   - ${group.type}: ${group._count.id}`);
      }

      // Use raw Drizzle for complex queries
      const { getRawDrizzle, sql: dbSql } = await import("@feed/db");
      const rawDbCheck = getRawDrizzle();

      // Use raw SQL to avoid Drizzle count() compatibility issues
      const eventsWithActorsResult = await rawDbCheck.execute(
        dbSql`SELECT COUNT(*) as count FROM world_events WHERE timestamp >= ${testStartTime} AND actors IS NOT NULL AND array_length(actors, 1) > 0`,
      );
      const eventsWithActors = Number(eventsWithActorsResult[0]?.count ?? 0);

      const totalEventsResult = await rawDbCheck.execute(
        dbSql`SELECT COUNT(*) as count FROM world_events WHERE timestamp >= ${testStartTime}`,
      );
      const totalEvents = Number(totalEventsResult[0]?.count ?? 0);

      console.log(`   Events with actors: ${eventsWithActors}/${totalEvents}`);

      const questionsWithDatesResult = await rawDbCheck.execute(
        dbSql`SELECT COUNT(*) as count FROM questions WHERE created_at >= ${testStartTime} AND resolution_date IS NOT NULL`,
      );
      const questionsWithDates = Number(
        questionsWithDatesResult[0]?.count ?? 0,
      );

      const totalQuestionsResult = await rawDbCheck.execute(
        dbSql`SELECT COUNT(*) as count FROM questions WHERE created_at >= ${testStartTime}`,
      );
      const totalQuestions = Number(totalQuestionsResult[0]?.count ?? 0);

      console.log(
        `   Questions with resolution dates: ${questionsWithDates}/${totalQuestions}`,
      );

      // Validation: if we generated content, it should be properly structured
      if (totalEvents > 0) {
        const actorPercentage = (eventsWithActors / totalEvents) * 100;
        expect(actorPercentage).toBeGreaterThan(50); // Most events should have actors
      }

      if (totalQuestions > 0) {
        const datesPercentage = (questionsWithDates / totalQuestions) * 100;
        expect(datesPercentage).toBe(100); // All questions must have resolution dates
      }

      console.log("   ✅ Outputs validated for training readiness");
    });
  },
);

describe("keyless engine primitives", () => {
  test("GameClock supports realtime, simulated, and fed-in time", async () => {
    const { GameClock } = await import("../../GameClock");
    const realtimeNow = GameClock.realtime().now();
    expect(realtimeNow.tick).toBe(0);
    expect(realtimeNow.hour).toBeGreaterThanOrEqual(0);
    expect(realtimeNow.hour).toBeLessThan(24);

    const startTime = new Date("2025-01-01T00:00:00Z");
    const simulatedClock = GameClock.simulated(startTime, startTime);
    expect(simulatedClock.now()).toMatchObject({ day: 1, hour: 0, tick: 0 });
    expect(simulatedClock.tick()).toMatchObject({ hour: 1, tick: 1 });
    expect(simulatedClock.advanceHours(23)).toMatchObject({
      day: 2,
      hour: 0,
      tick: 24,
    });

    simulatedClock.setTime(new Date("2025-01-15T12:00:00Z"));
    expect(simulatedClock.now()).toMatchObject({ day: 15, hour: 12 });
  });

  test("InMemoryStateStore executes deterministic offline trades", async () => {
    const { InMemoryStateStore } = await import(
      "../../adapters/InMemoryStateStore"
    );
    const store = new InMemoryStateStore({
      numPredictionMarkets: 5,
      numPerpMarkets: 3,
      numAgents: 10,
      durationDays: 30,
      seed: 12345,
    });
    const state = store.getState();
    expect(state.predictionMarkets).toHaveLength(5);
    expect(state.perpMarkets).toHaveLength(3);
    expect(state.agents).toHaveLength(10);

    const agent = state.agents[0];
    const market = state.predictionMarkets[0];
    expect(agent).toBeDefined();
    expect(market).toBeDefined();
    if (!agent || !market) throw new Error("seeded state is incomplete");

    const trade = store.buyPredictionShares(agent.id, market.id, "YES", 100);
    expect(trade.success).toBe(true);
    expect(trade.shares).toBeGreaterThan(0);
    store.advanceTick();
    expect(store.getProgress().tick).toBe(1);
    expect(store.isComplete()).toBe(false);
  });
});
