/// Old phone evidence is deleted after PHONE_EVIDENCE_KEEP_DAYS, as the privacy
/// policy promises: twice a day, the first a couple of minutes after boot.
import { pruneOldEvidence } from './db.js';

export function startRetention() {
  const tick = () => pruneOldEvidence()
    .then((removed) => {
      const n = Object.values(removed).reduce((a, b) => a + b, 0);
      if (n) console.log('[attendance] deleted old phone evidence:', JSON.stringify(removed));
    })
    .catch((e) => console.error('[attendance] retention failed:', e && e.message));
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  setInterval(tick, 12 * 60 * 60 * 1000).unref?.();
}
