/**
 * All of Studio's words in Arabic, loaded only when someone chooses Arabic, so others never download
 * them. Each part is checked against English where it is written.
 */
import { aiPowerAr } from '../ai-power/ar';
import { ar } from '../ar';
import { billingAr } from '../billing/ar';
import { goLiveAr } from '../go-live/ar';
import { inboxAlertsAr } from '../inbox-alerts/ar';
import { migrationAr } from '../migration/ar';
import { paletteAr } from '../palette/ar';
import { platformCopy } from '../platform';
import { setupAr } from '../setup/ar';

export default {
  ...ar,
  agentic: platformCopy.ar,
  migration: migrationAr,
  billing: billingAr,
  setup: setupAr,
  inboxAlerts: inboxAlertsAr,
  aiPower: aiPowerAr,
  palette: paletteAr,
  goLive: goLiveAr,
};
