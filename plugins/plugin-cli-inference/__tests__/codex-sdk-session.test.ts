/**
 * Unit tests for isolated Codex SDK calls, driven by a FAKE CodexModule via the
 * constructor's injectable `codexModule` seam (no real `@openai/codex-sdk`, no
 * real `codex` process). Each "turn script" describes the completed turn the fake
 * thread returns: its `finalResponse` (or item text), or an error to throw.
 */

import { describe, expect, it } from "vitest";
import { type CodexModule, CodexSdkSession } from "../src/codex-sdk-session";

interface TurnScript {
  finalResponse?: string;
  itemText?: string;
  throws?: string;
}

interface CapturedTurn {
  input: string;
  options: { outputSchema?: unknown } | undefined;
}

function makeFakeCodex(scripts: TurnScript[]): {
  codexModule: CodexModule;
  starts: () => number;
  codexOptions: () => Array<Record<string, unknown>>;
  threadOptions: () => Array<Record<string, unknown>>;
  turns: () => CapturedTurn[];
} {
  let startCount = 0;
  let turn = 0;
  const constructedOptions: Array<Record<string, unknown>> = [];
  const startedThreadOptions: Array<Record<string, unknown>> = [];
  const capturedTurns: CapturedTurn[] = [];
  const codexModule = {
    Codex: class {
      constructor(options?: Record<string, unknown>) {
        constructedOptions.push(options ?? {});
      }

      startThread(options?: Record<string, unknown>) {
        startCount += 1;
        startedThreadOptions.push(options ?? {});
        return {
          run: async (input: string, options?: { outputSchema?: unknown }) => {
            capturedTurns.push({ input, options });
            const s = scripts[turn++] ?? {};
            if (s.throws) throw new Error(s.throws);
            const items = s.itemText ? [{ type: "agent_message", text: s.itemText }] : [];
            return { items, finalResponse: s.finalResponse, usage: null };
          },
        };
      }
    },
  } as unknown as CodexModule;
  return {
    codexModule,
    starts: () => startCount,
    codexOptions: () => constructedOptions,
    threadOptions: () => startedThreadOptions,
    turns: () => capturedTurns,
  };
}

function makeSession(
  scripts: TurnScript[],
  opts: {
    router?: boolean;
    reasoningEffort?: string;
    subprocessEnv?: Record<string, string | undefined>;
  } = {}
) {
  const fake = makeFakeCodex(scripts);
  const session = new CodexSdkSession({
    model: "gpt-test",
    router: opts.router ?? false,
    reasoningEffort: opts.reasoningEffort,
    subprocessEnv: opts.subprocessEnv,
    codexModule: fake.codexModule,
  });
  return { session, ...fake };
}

describe("CodexSdkSession — TEXT mode", () => {
  it("returns the turn finalResponse", async () => {
    const { session, turns } = makeSession([{ finalResponse: "hello" }]);
    expect(await session.generate("hi")).toBe("hello");
    expect(turns()).toEqual([{ input: "hi", options: undefined }]);
    session.dispose();
  });

  it("forwards a response schema as the Codex turn outputSchema", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    } as const;
    const { session, turns } = makeSession([{ finalResponse: '{"answer":"hello"}' }]);

    expect(await session.generate("hi", schema)).toBe('{"answer":"hello"}');
    expect(turns()).toEqual([{ input: "hi", options: { outputSchema: schema } }]);
    session.dispose();
  });

  it("closes nested objects and requires every property for strict Codex output", async () => {
    const schema = {
      type: "object",
      properties: {
        success: { type: "boolean" },
        copyToClipboard: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "content"],
        },
      },
      required: ["success"],
    } as const;
    const { session, turns } = makeSession([{ finalResponse: '{"success":true}' }]);

    await session.generate("evaluate", schema);

    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["success", "copyToClipboard"],
      properties: {
        copyToClipboard: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["title", "content", "tags"],
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            tags: { type: ["array", "null"] },
          },
        },
      },
    });
    expect(schema.required).toEqual(["success"]);
    expect(schema.properties.copyToClipboard.required).toEqual(["title", "content"]);
    session.dispose();
  });

  it("preserves an explicitly nullable object while closing its nested shape", async () => {
    const schema = {
      type: "object",
      properties: {
        result: {
          type: "object",
          nullable: true,
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
      required: ["result"],
    } as const;
    const { session, turns } = makeSession([{ finalResponse: '{"result":null}' }]);

    await session.generate("evaluate", schema);

    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      properties: {
        result: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["value"],
        },
      },
    });
    expect(schema.properties.result.nullable).toBe(true);
    session.dispose();
  });

  it("allows null for optional enum properties after strict required normalization", async () => {
    const schema = {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "remove"],
        },
      },
    } as const;
    const { session, turns } = makeSession([{ finalResponse: '{"operation":null}' }]);

    expect(await session.generate("evaluate", schema)).toBe("{}");

    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      required: ["operation"],
      properties: {
        operation: {
          type: ["string", "null"],
          enum: ["add", "remove", null],
        },
      },
    });
    expect(schema.properties.operation.enum).toEqual(["add", "remove"]);
    session.dispose();
  });

  it("restores optional null placeholders to omission through nested arrays", async () => {
    const schema = {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              operation: { type: "string", enum: ["add", "remove"] },
              statement: { type: "string" },
              evidence: { type: "string" },
              confidence: { type: "number", nullable: true },
            },
            required: ["operation", "statement"],
          },
        },
      },
      required: ["operations"],
    } as const;
    const { session } = makeSession([
      {
        finalResponse:
          '{"operations":[{"operation":"add","statement":"likes tea","evidence":null,"confidence":null}]}',
      },
    ]);

    expect(JSON.parse(await session.generate("extract", schema))).toEqual({
      operations: [
        {
          operation: "add",
          statement: "likes tea",
          confidence: null,
        },
      ],
    });
    session.dispose();
  });

  it("round-trips unconstrained values through a strict JSON envelope", async () => {
    const schema = {
      type: "object",
      properties: { value: {} },
      required: ["value"],
    } as const;
    const { session, turns } = makeSession([
      { finalResponse: '{"value":{"__eliza_json":"{\\"nested\\":true}"}}' },
    ]);

    expect(await session.generate("extract", schema)).toBe('{"value":{"nested":true}}');
    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      properties: {
        value: {
          type: "object",
          additionalProperties: false,
          required: ["__eliza_json"],
          properties: { __eliza_json: { type: "string" } },
        },
      },
    });
    session.dispose();
  });

  it("preserves open object maps instead of silently closing and emptying them", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      required: ["metadata"],
    } as const;
    const { session, turns } = makeSession([
      {
        finalResponse: '{"metadata":{"__eliza_json":"{\\"dynamic\\":\\"preserved\\"}"}}',
      },
    ]);

    expect(await session.generate("extract", schema)).toBe('{"metadata":{"dynamic":"preserved"}}');
    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      properties: {
        metadata: {
          type: "object",
          additionalProperties: false,
          required: ["__eliza_json"],
        },
      },
    });
    session.dispose();
  });

  it("preserves nullability when an open object map uses a type union", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        metadata: {
          type: ["object", "null"],
          additionalProperties: { type: "string" },
        },
      },
      required: ["metadata"],
    } as const;
    const { session, turns } = makeSession([{ finalResponse: '{"metadata":null}' }]);

    expect(await session.generate("extract", schema)).toBe('{"metadata":null}');
    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      properties: {
        metadata: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["__eliza_json"],
        },
      },
    });
    session.dispose();
  });

  it("round-trips an open root object through the strict JSON envelope", async () => {
    const schema = { type: "object", additionalProperties: true } as const;
    const { session, turns } = makeSession([
      { finalResponse: '{"__eliza_json":"{\\"dynamic\\":42}"}' },
    ]);

    expect(await session.generate("extract", schema)).toBe('{"dynamic":42}');
    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["__eliza_json"],
    });
    session.dispose();
  });

  it("removes unsupported open-map keywords from the strict envelope", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        labels: {
          type: "object",
          patternProperties: { "^[a-z]+$": { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["labels"],
    } as const;
    const { session, turns } = makeSession([
      { finalResponse: '{"labels":{"__eliza_json":"{\\"team\\":\\"core\\"}"}}' },
    ]);

    expect(await session.generate("extract", schema)).toBe('{"labels":{"team":"core"}}');
    const normalizedLabels = (
      turns()[0]?.options?.outputSchema as {
        properties?: { labels?: Record<string, unknown> };
      }
    )?.properties?.labels;
    expect(normalizedLabels).not.toHaveProperty("patternProperties");
    expect(normalizedLabels).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["__eliza_json"],
    });
    session.dispose();
  });

  it("rejects a nullable root schema", async () => {
    const schema = {
      type: ["object", "null"],
      properties: { answer: { type: "string" } },
      required: ["answer"],
    } as const;
    const { session } = makeSession([{ finalResponse: '{"answer":"hello"}' }]);

    await expect(session.generate("evaluate", schema)).rejects.toThrow(
      /output schema root cannot be nullable/
    );
    session.dispose();
  });

  it("passes rotated account env to the Codex SDK constructor only", async () => {
    const subprocessEnv = { PATH: "/bin", CODEX_HOME: "/selected/codex" };
    const { session, codexOptions } = makeSession([{ finalResponse: "hello" }], {
      subprocessEnv,
    });
    expect(await session.generate("hi")).toBe("hello");
    expect(codexOptions()[0].env).toBe(subprocessEnv);
    session.dispose();
  });

  it("pins a supported default effort instead of inheriting ambient Codex config", async () => {
    const { session, threadOptions } = makeSession([{ finalResponse: "hello" }]);
    expect(await session.generate("hi")).toBe("hello");
    expect(threadOptions()[0]?.modelReasoningEffort).toBe("high");
    session.dispose();
  });

  it.each(["max", "ultra"])("maps the host-only %s effort alias to xhigh", async (alias) => {
    const { session, threadOptions } = makeSession([{ finalResponse: "hello" }], {
      reasoningEffort: alias,
    });
    expect(await session.generate("hi")).toBe("hello");
    expect(threadOptions()[0]?.modelReasoningEffort).toBe("xhigh");
    session.dispose();
  });

  it.each(["none", "impossible"])(
    "rejects unsupported %s effort before starting a subscription turn",
    (reasoningEffort) => {
      expect(() => makeSession([], { reasoningEffort })).toThrow(/unsupported reasoning effort/);
    }
  );

  it("falls back to the last agent_message item text", async () => {
    const { session } = makeSession([{ itemText: "from item" }]);
    expect(await session.generate("hi")).toBe("from item");
    session.dispose();
  });

  it("throws on an empty completion (fail over)", async () => {
    const { session } = makeSession([{ finalResponse: "" }]);
    await expect(session.generate("hi")).rejects.toThrow(/empty completion/);
    session.dispose();
  });

  it("rejects an empty prompt body", async () => {
    const { session } = makeSession([{ finalResponse: "x" }]);
    await expect(session.generate("   ")).rejects.toThrow(/empty prompt body/);
    session.dispose();
  });

  it("isolates a failed turn from the next call", async () => {
    const { session, starts } = makeSession([{ throws: "boom" }, { finalResponse: "recovered" }]);
    await expect(session.generate("a")).rejects.toThrow(/boom/);
    expect(await session.generate("b")).toBe("recovered");
    expect(starts()).toBe(2);
    session.dispose();
  });

  it("starts a fresh thread for every sequential model call", async () => {
    const { session, starts } = makeSession([{ finalResponse: "one" }, { finalResponse: "two" }]);
    expect(await session.generate("1")).toBe("one");
    expect(await session.generate("2")).toBe("two");
    expect(starts()).toBe(2);
    session.dispose();
  });
});

describe("CodexSdkSession — ROUTE mode (native outputSchema)", () => {
  it("parses a bare {action,params} JSON from the turn's finalResponse", async () => {
    const { session, turns } = makeSession(
      [{ finalResponse: '{"action":"WEB_FETCH","params":"{\\"url\\":\\"u\\"}"}' }],
      { router: true }
    );
    const out = JSON.parse(await session.route("price?"));
    expect(out).toEqual({ action: "WEB_FETCH", params: { url: "u" } });
    expect(turns()[0]?.options?.outputSchema).toMatchObject({
      type: "object",
      required: ["action", "params"],
    });
    session.dispose();
  });

  it("salvages a JSON object wrapped in prose", async () => {
    const { session } = makeSession(
      [
        {
          finalResponse:
            'Sure, here is the action: {"action":"REPLY","params":"{\\"text\\":\\"4\\"}"} — let me know if you need anything else.',
        },
      ],
      { router: true }
    );
    const out = JSON.parse(await session.route("2+2?"));
    expect(out).toEqual({ action: "REPLY", params: { text: "4" } });
    session.dispose();
  });

  it("rejects malformed params instead of fabricating an empty object", async () => {
    const { session } = makeSession(
      [{ finalResponse: '{"action":"IGNORE","params":"not valid json"}' }],
      {
        router: true,
      }
    );
    await expect(session.route("hi")).rejects.toThrow(/non-JSON params output/);
    session.dispose();
  });

  it("rejects params JSON that does not encode an object", async () => {
    const { session } = makeSession([{ finalResponse: '{"action":"IGNORE","params":"[]"}' }], {
      router: true,
    });
    await expect(session.route("hi")).rejects.toThrow(/must encode an object/);
    session.dispose();
  });

  it("throws when the structured output has no action", async () => {
    const { session } = makeSession([{ finalResponse: '{"params":{}}' }], {
      router: true,
    });
    await expect(session.route("hi")).rejects.toThrow(/missing action/);
    session.dispose();
  });

  it("throws on non-JSON route output", async () => {
    const { session } = makeSession([{ finalResponse: "not json at all" }], {
      router: true,
    });
    await expect(session.route("hi")).rejects.toThrow(/non-JSON output/);
    session.dispose();
  });
});

describe("CodexSdkSession — serialization", () => {
  it("serializes concurrent calls without interleaving", async () => {
    const { session, starts } = makeSession(
      [
        { finalResponse: '{"action":"A","params":"{}"}' },
        { finalResponse: '{"action":"B","params":"{}"}' },
      ],
      { router: true }
    );
    const [r1, r2] = await Promise.all([session.route("one"), session.route("two")]);
    const actions = [JSON.parse(r1).action, JSON.parse(r2).action].sort();
    expect(actions).toEqual(["A", "B"]);
    expect(starts()).toBe(2);
    session.dispose();
  });
});
