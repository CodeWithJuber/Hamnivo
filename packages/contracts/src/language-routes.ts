import { SetWidgetLanguageRequest, WidgetLanguageState } from './language.js';
import type { RouteDef } from './routes.js';

/** A customer's language settings, from the widget (U01, HNV-07-04). */
export const languageRoutes = {
  getWidgetLanguage: {
    method: 'get',
    path: '/v1/widget/language',
    operationId: 'getWidgetLanguage',
    summary: 'Reply language, interface locale and style of this customer',
    tags: ['Widget'],
    auth: 'widget_session',
    success: { status: 200, description: 'Language settings', schema: WidgetLanguageState },
  },
  setWidgetLanguage: {
    // POST: the widget's cross-origin surface allows only GET and POST.
    method: 'post',
    path: '/v1/widget/language',
    operationId: 'setWidgetLanguage',
    summary: 'Choose a reply language or style, or close the language question',
    tags: ['Widget'],
    auth: 'widget_session',
    body: SetWidgetLanguageRequest,
    success: { status: 200, description: 'Language settings', schema: WidgetLanguageState },
  },
} as const satisfies Record<string, RouteDef>;
