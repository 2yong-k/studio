import type { Provider } from '../provider.ts';
import { createFalProvider } from './fal/index.ts';

export { createFakeProvider, FAKE_SCENARIOS, type FakeScenario } from './fake/index.ts';

// The one place that picks the live service, so commands choose live or fake without naming it.
export function createLiveProvider(o: { key: string }): Provider {
  return createFalProvider({ key: o.key });
}
