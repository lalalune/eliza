/**
 * Verifies workflow-route principal proof and branded managed-container aliases.
 */
import { buildBrandEnvAliases, getBootConfig, setBootConfig } from '@elizaos/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getForwardedWorkflowPrincipal,
  isCloudWorkflowPrincipalRequired,
} from '../../src/routes/_helpers';

const ENV_KEYS = [
  'ELIZA_CLOUD_PROVISIONED',
  'ELIZA_API_TOKEN',
  'MILADY_CLOUD_PROVISIONED',
  'MILADY_API_TOKEN',
] as const;

describe('workflow route principal proof', () => {
  const originalConfig = getBootConfig();
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    setBootConfig({
      ...originalConfig,
      envAliases: buildBrandEnvAliases('MILADY'),
    });
  });

  afterEach(() => {
    setBootConfig(originalConfig);
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  test('accepts the gateway principal through branded Cloud credentials', () => {
    process.env.MILADY_CLOUD_PROVISIONED = '1';
    process.env.MILADY_API_TOKEN = 'milady-agent-token';

    expect(isCloudWorkflowPrincipalRequired()).toBe(true);
    expect(
      getForwardedWorkflowPrincipal({
        headers: {
          'x-eliza-user-id': 'user-1',
          'x-eliza-principal-token': 'milady-agent-token',
        },
      })
    ).toBe('user-1');
  });

  test('requires a principal when the branded provisioning flag uses true', () => {
    process.env.MILADY_CLOUD_PROVISIONED = 'true';

    expect(isCloudWorkflowPrincipalRequired()).toBe(true);
  });

  test('rejects spoofed proof and honors an explicit canonical override', () => {
    process.env.ELIZA_CLOUD_PROVISIONED = '0';
    process.env.MILADY_CLOUD_PROVISIONED = '1';
    process.env.ELIZA_API_TOKEN = 'canonical-token';
    process.env.MILADY_API_TOKEN = 'milady-token';

    expect(isCloudWorkflowPrincipalRequired()).toBe(false);
    expect(
      getForwardedWorkflowPrincipal({
        headers: {
          'x-eliza-user-id': 'user-1',
          'x-eliza-principal-token': 'milady-token',
        },
      })
    ).toBeUndefined();
  });
});
