/**
 * Engine version, recorded on every run and lock.
 *
 * Locks are only accepted on the current engine version, and the verify job only re-runs
 * locks made on its own version. Bump this whenever a change can alter sim output
 * (engine code, rng, model.config values). A golden-output test (step 3) fails if output
 * changes without a bump.
 */
export const ENGINE_VERSION = '0.2.0';
