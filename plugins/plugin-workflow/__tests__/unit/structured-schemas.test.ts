/** Verifies workflow response schemas satisfy the strict JSON contract used by subscription-backed structured output. */
import { describe, expect, test } from 'bun:test';
import {
  draftIntentSchema,
  feasibilitySchema,
  keywordExtractionSchema,
  workflowMatchingSchema,
} from '../../src/schemas/index';

function assertStrictObjectSchemas(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertStrictObjectSchemas(entry, `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') {
    const properties = schema.properties as Record<string, unknown> | undefined;
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(schema.required, `${path}.required`).toEqual(Object.keys(properties ?? {}));
  }

  for (const [key, child] of Object.entries(schema)) {
    assertStrictObjectSchemas(child, `${path}.${key}`);
  }
}

describe('workflow structured-output schemas', () => {
  test.each([
    ['keyword extraction', keywordExtractionSchema],
    ['draft intent', draftIntentSchema],
    ['workflow matching', workflowMatchingSchema],
    ['feasibility', feasibilitySchema],
  ])('%s is accepted by strict subscription model transports', (_name, schema) => {
    assertStrictObjectSchemas(schema);
    expect(JSON.stringify(schema)).not.toContain('"nullable"');
  });
});
