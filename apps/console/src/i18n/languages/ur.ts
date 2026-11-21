/**
 * All of Studio's words in Urdu, loaded only when someone chooses Urdu, so others never download
 * them. Each part is checked against English where it is written.
 */
import { aiPowerUr } from '../ai-power/ur';
import { billingUr } from '../billing/ur';
import { goLiveUr } from '../go-live/ur';
import { inboxAlertsUr } from '../inbox-alerts/ur';
import { migrationUr } from '../migration/ur';
import { paletteUr } from '../palette/ur';
import { platformCopy } from '../platform';
import { setupUr } from '../setup/ur';
import { ur } from '../ur';

export default {
  ...ur,
  agentic: platformCopy.ur,
  migration: migrationUr,
  billing: billingUr,
  setup: setupUr,
  inboxAlerts: inboxAlertsUr,
  aiPower: aiPowerUr,
  palette: paletteUr,
  goLive: goLiveUr,
};
