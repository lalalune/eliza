/** JSON schema for the feasibility-check LLM call: `{ feasible, reason }`. */
export const feasibilitySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    feasible: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['feasible', 'reason'],
};
