// The opaque shop token belongs to wire.ts's seeded viewer; it has no encoded login.
// Reuse the published identity generator rather than guessing from request paths.
import { generateUsers, scenarioRng } from './docs/conformance/wire.ts';
export const viewer = generateUsers(scenarioRng('users'), 1)[0]!;
