import { initFlaxiaNode } from './client/SignalingClient';

// Pure storage read: returns the persisted consent state without creating a
// controller or touching the network. Hosts use this to render a settings
// screen before the node has been initialised. Fail-closed: a stored record
// only counts once `initFlaxiaNodeConsent()` has verified its HMAC, so hosts
// that can await should do so before trusting a `'granted'` result.
export { getConsentState as getFlaxiaNodeConsentState } from './consent/storage';
// Explicit async initialisation of the consent integrity layer (loads or
// creates the non-extractable HMAC key and verifies the stored record).
export { initConsentIntegrity as initFlaxiaNodeConsent } from './consent/storage';
// Host-managed consent opt-in. Disabled by default: without it a host-supplied
// `onConsentRequired` accept() cannot grant consent unless the built-in banner
// was rendered and accepted by the visitor.
export { setHostManagedConsentAllowed as setFlaxiaNodeHostManagedConsent } from './consent/storage';
export { initFlaxiaNode };
export type { ConsentControls, ConsentState, FlaxiaNodeController } from '@flaxia/sdk';