import { runHelper } from './helper';
import { createSwarmRuntime } from '../../node/src/swarm/runtime';
import * as engine from '../../node/src/swarm/engine-entry.js';
await runHelper(createSwarmRuntime(async () => engine as any));
