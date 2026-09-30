import { generateTotp } from "../../src/auth/crypto.js";

/**
 * TOTP codes for tests, under the rule that a code (a 30-second time step) is accepted at most
 * once per account (D75). The server accepts the steps now-1, now and now+1, so up to three
 * sign-ins in a row can succeed without waiting; the fourth waits for the next step, exactly
 * as a person would.
 *
 * The helper remembers, per secret, the last step it handed out and always returns the code
 * for a later step. It never touches the database: every code still goes through the real
 * verification and the real replay check.
 */

const STEP_MS = 30_000;
const lastStep = new Map<string, number>();

/** Waits so at least `marginMs` of the current step remain; a code must not expire in flight. */
async function awayFromBoundary(marginMs = 3_000): Promise<void> {
  const into = Date.now() % STEP_MS;
  if (STEP_MS - into < marginMs) await new Promise((r) => setTimeout(r, STEP_MS - into + 50));
}

export async function nextTotpCode(secret: string): Promise<string> {
  for (;;) {
    await awayFromBoundary();
    const now = Math.floor(Date.now() / STEP_MS);
    const used = lastStep.get(secret) ?? -Infinity;
    const step = [now - 1, now, now + 1].find((s) => s > used);
    if (step !== undefined) {
      lastStep.set(secret, step);
      return generateTotp(secret, step * STEP_MS);
    }
    // All three accepted steps are spent: wait for the next one.
    await new Promise((r) => setTimeout(r, STEP_MS - (Date.now() % STEP_MS) + 50));
  }
}
