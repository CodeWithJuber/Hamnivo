/**
 * Values with no schema around them, kept in a module that does not import zod. The chat's first
 * script uses them; taken from a module of schemas, they would bring zod and every schema of that
 * module with them.
 */

/** Marks the messages of the host-page bridge (blueprint §10). */
export const BRIDGE_SOURCE = 'hamnivo';
export const BRIDGE_VERSION = 1;

/** The explanation of customer memory a customer agrees to. */
export const MEMORY_NOTICE_VERSION = 'memory-notice/1';

/** The reactions a message can get. */
export const REACTIONS = ['👍', '👎', '❤️', '🙏', '😊'] as const;

/** How the chat sits on the page: a launcher bubble, a panel, inline in the page, or full page. */
export const WIDGET_LAYOUT_MODES = ['bubble', 'panel', 'inline', 'fullpage'] as const;
