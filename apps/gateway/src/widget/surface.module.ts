import type { Provider } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { type Scanner, type ScanVerdict, scannerFromUrl } from '../knowledge/scanner.js';
import { ATTACHMENT_SCANNER, WidgetAttachmentsService } from './attachments.service.js';

export { filesScannable } from './attachments.service.js';

import { CustomerEmailsService } from './customer-emails.service.js';
import { WidgetHelpService } from './help.service.js';
import { WidgetMessagesService } from './messages.service.js';
import { WidgetNotificationsService } from './notifications.service.js';
import { SessionSignals } from './session-signals.service.js';
import { WidgetSettingsController } from './settings.controller.js';
import { WidgetSettingsService } from './settings.service.js';
import { NotificationsController, WidgetSurfaceController } from './surface.controller.js';

/** A scanner that refuses everything: production without ClamAV never takes customer files. */
class NoScanner implements Scanner {
  async scan(): Promise<ScanVerdict> {
    return { clean: false, engine: 'none', reason: 'scan_unavailable' };
  }
}

/**
 * The scanner for customer files (W09): ClamAV when CLAMAV_URL is set; the EICAR test check in
 * development and tests; in production without ClamAV, none, so every file is refused and the
 * widget does not offer files at all.
 */
export function attachmentScanner(config: AppConfig): Scanner {
  if (config.CLAMAV_URL) return scannerFromUrl(config.CLAMAV_URL);
  return config.NODE_ENV === 'production' ? new NoScanner() : scannerFromUrl(undefined);
}

/** The customer surface of the widget (W02, W05–W07, W09, W17–W19, W22–W25) in the API. */
export const WIDGET_SURFACE_API_CONTROLLERS = [
  WidgetSurfaceController,
  NotificationsController,
  WidgetSettingsController,
];

export function widgetSurfaceApiProviders(config: AppConfig, scanner?: Scanner): Provider[] {
  return [
    { provide: ATTACHMENT_SCANNER, useValue: scanner ?? attachmentScanner(config) },
    SessionSignals,
    WidgetSettingsService,
    WidgetAttachmentsService,
    WidgetMessagesService,
    WidgetHelpService,
    WidgetNotificationsService,
  ];
}

/** The worker side: customer emails (W25). */
export const WIDGET_SURFACE_WORKER_PROVIDERS: Provider[] = [CustomerEmailsService];
