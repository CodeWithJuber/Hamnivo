import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExtractionAnswer } from '../src/memory/extraction.service.js';

/**
 * What the memory extraction asks a model for must be accepted by every provider's structured
 * output. OpenAI's strict mode refuses a schema with a property left out of `required`, or with
 * length rules on strings; the limits are applied to the answer instead.
 */
describe('the memory extraction schema', () => {
  it('names every property as required and has no length rules', () => {
    const schema = z.toJSONSchema(ExtractionAnswer) as Record<string, any>;
    const objects: Array<Record<string, any>> = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const value = node as Record<string, any>;
      if (value.type === 'object' && value.properties) objects.push(value);
      for (const child of Object.values(value)) walk(child);
    };
    walk(schema);
    expect(objects.length).toBeGreaterThanOrEqual(2);
    for (const object of objects) {
      expect(new Set(object.required)).toEqual(new Set(Object.keys(object.properties)));
    }
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"(minLength|maxLength|pattern)"/);
  });
});
