/** Verifies the plugin registers its routes and auto-registers the Google plugin dependency when absent. Deterministic vitest with a stubbed runtime plugin registrar. */
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  type Plugin,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeviceId, resetCachedDeviceId } from "./lifeops/device-identity.js";
import {
  ensureLifeOpsGooglePluginRegistered,
  personalAssistantPlugin,
} from "./plugin.js";
import { personalAssistantRoutesPlugin } from "./routes/plugin.js";

function createRuntimeWithPluginRegistration(initialPlugins: Plugin[] = []): {
  runtime: IAgentRuntime;
  plugins: Plugin[];
  registerPlugin: ReturnType<typeof vi.fn>;
} {
  const plugins = [...initialPlugins];
  let runtime: IAgentRuntime;
  const registerPlugin = vi.fn(async (plugin: Plugin) => {
    plugins.push(plugin);
    await plugin.init?.({}, runtime);
  });
  runtime = {
    plugins,
    registerPlugin,
    getService: vi.fn(() => null),
    getSetting: vi.fn(() => undefined),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as IAgentRuntime;
  return { runtime, plugins, registerPlugin };
}

afterEach(() => resetCachedDeviceId());

describe("LifeOps Google plugin registration", () => {
  it("exposes the owner todo action for todos-routed planner turns", () => {
    const todoAction = personalAssistantPlugin.actions?.find(
      (action) => action.name === "OWNER_TODOS",
    );

    expect(todoAction?.contexts).toContain("todos");
  });

  it("validates normal owner todo requests for the owner todo action", async () => {
    const todoAction = personalAssistantPlugin.actions?.find(
      (action) => action.name === "OWNER_TODOS",
    );

    await expect(
      todoAction?.validate?.(
        { getRoom: async () => null } as IAgentRuntime,
        {
          content: { text: "add a todo: pick up dry cleaning tomorrow" },
        } as never,
      ),
    ).resolves.toBe(true);
  });

  it("declares plugin-google for app and route plugin dependency resolution", () => {
    expect(personalAssistantPlugin.dependencies).toContain(
      "@elizaos/plugin-google",
    );
    expect(personalAssistantRoutesPlugin.dependencies).toContain(
      "@elizaos/plugin-google",
    );
  });

  it("registers plugin-google when LifeOps is registered directly", async () => {
    const { runtime, plugins, registerPlugin } =
      createRuntimeWithPluginRegistration();

    await ensureLifeOpsGooglePluginRegistered(runtime);

    expect(registerPlugin).toHaveBeenCalledTimes(1);
    expect(plugins.map((plugin) => plugin.name)).toContain("google");
    expect(registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "google",
        init: expect.any(Function),
      }),
    );
  });

  it("registers generic Google connector routes without legacy LifeOps setup routes", () => {
    const routePaths = (personalAssistantRoutesPlugin.routes ?? []).map(
      (route) => route.path,
    );

    expect(routePaths).toContain("/api/connectors/google/oauth/start");
    expect(routePaths).toContain("/api/connectors/google/oauth/callback");
    expect(routePaths).toContain("/api/connectors/google/accounts");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/status");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/accounts");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/success");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/start");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/callback");
    expect(routePaths).not.toContain(
      "/api/lifeops/connectors/google/disconnect",
    );
  });

  it("does not register plugin-google twice", async () => {
    const { runtime, registerPlugin } = createRuntimeWithPluginRegistration([
      {
        name: "google",
        description: "already loaded",
      } as Plugin,
    ]);

    await ensureLifeOpsGooglePluginRegistered(runtime);

    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("drops the cached device identity during plugin disposal", async () => {
    expect(getDeviceId({ ELIZA_DEVICE_ID: "device-before-dispose" })).toBe(
      "device-before-dispose",
    );
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "LifeOps disposal test" }),
      logLevel: "fatal",
    });

    await personalAssistantPlugin.dispose?.(runtime);

    expect(getDeviceId({ ELIZA_DEVICE_ID: "device-after-dispose" })).toBe(
      "device-after-dispose",
    );
  });
});
