/** Dependency-injection tokens for values that are not classes. */
export const CONFIG = Symbol('CONFIG');
export const APP_DB = Symbol('APP_DB');
export const PLATFORM_DB = Symbol('PLATFORM_DB');
export const REDIS = Symbol('REDIS');
export const AUTH = Symbol('AUTH');
export const MAILER = Symbol('MAILER');
export const CLOCK = Symbol('CLOCK');
/** Replaces DNS resolution for every outbound request made for a tenant (tests of the guard). */
export const EGRESS_RESOLVER = Symbol('EGRESS_RESOLVER');

export type Clock = () => Date;
