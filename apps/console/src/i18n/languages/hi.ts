/**
 * All of Studio's words in Hindi, loaded only when someone chooses Hindi, so others never download
 * them. Each part is checked against English where it is written.
 */
import { aiPowerHi } from '../ai-power/hi';
import { billingHi } from '../billing/hi';
import { goLiveHi } from '../go-live/hi';
import { hi } from '../hi';
import { inboxAlertsHi } from '../inbox-alerts/hi';
import { migrationHi } from '../migration/hi';
import { paletteHi } from '../palette/hi';
import { platformCopy } from '../platform';
import { setupHi } from '../setup/hi';

export default {
  ...hi,
  agentic: platformCopy.hi,
  migration: migrationHi,
  billing: billingHi,
  setup: setupHi,
  inboxAlerts: inboxAlertsHi,
  aiPower: aiPowerHi,
  palette: paletteHi,
  goLive: goLiveHi,
};
