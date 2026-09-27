/** Dependency-injection tokens for values that are not classes. */
export const CONFIG = Symbol('CONFIG');
export const APP_DB = Symbol('APP_DB');
export const PLATFORM_DB = Symbol('PLATFORM_DB');
export const REDIS = Symbol('REDIS');
export const AUTH = Symbol('AUTH');
export const MAILER = Symbol('MAILER');
export const CLOCK = Symbol('CLOCK');

export type Clock = () => Date;
