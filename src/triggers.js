import { Router } from 'express';

export const triggerRouter = Router();

// Entry point for ESP32 trigger devices and the dashboard "test trigger" button.
// Server-side validation (identity, debounce, cooldown, retrigger policy) belongs
// here; show mapping lives in server configuration, never in the trigger device.
// See spec section 5.1.
triggerRouter.post('/:trigger_id', (req, res) => {
  const { trigger_id: triggerId } = req.params;
  console.log(`trigger received: ${triggerId}`);
  // TODO: authenticate trigger, enforce debounce/cooldown/retrigger policy,
  // map trigger -> displays/groups/production, dispatch mode-appropriate
  // playback commands (Arm/Go in Controlled mode).
  res.status(202).json({ accepted: true, trigger_id: triggerId });
});
