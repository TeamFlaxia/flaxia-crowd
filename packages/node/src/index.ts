import { initFlaxiaNode } from './client/SignalingClient';

// Pure storage read: returns the persisted consent state without creating a
// controller or touching the network. Hosts use this to render a settings
// screen before the node has been initialised.
export { getConsentState as getFlaxiaNodeConsentState } from './consent/storage';
export { initFlaxiaNode };
export type { ConsentControls, ConsentState, FlaxiaNodeController } from '@flaxia/sdk';
