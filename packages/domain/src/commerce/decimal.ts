import * as decimalModule from 'decimal.js';

/**
 * decimal.js publishes an ES module whose only export is the default, with type declarations
 * written for CommonJS. Reading `default` from the namespace object is correct at run time in
 * Node, Vite and Vitest, and keeps the class and its namespace types.
 */
type DecimalClass = typeof decimalModule.Decimal;

export const DecimalBase = (decimalModule as unknown as { default: DecimalClass }).default;
export type DecimalValue = InstanceType<DecimalClass>;
export type DecimalRounding = decimalModule.Decimal.Rounding;
