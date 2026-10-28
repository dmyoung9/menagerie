/** Called by pytest with responses produced by the real ASGI app, never a live service. */
import { readFileSync } from 'node:fs';
import * as contracts from '../src/contracts.ts';
import { array, object } from '../src/decode.ts';

object({
  catalog: array(contracts.catalogModel),
  status: contracts.status,
  models: array(contracts.artifact),
  runtimes: array(contracts.runtime),
  profiles: array(contracts.profile),
  deployments: array(contracts.deployment),
  serving: array(contracts.servingDeployment),
  jobs: array(contracts.job),
  preview: contracts.resourcePreview,
  sessions: array(contracts.historySession),
  requests: array(contracts.historyRequest),
  recommendation: contracts.engineRecommendation,
  activations: array(contracts.historyActivation),
  events: array(contracts.operationEvent),
  revisions: array(contracts.profile),
})(JSON.parse(readFileSync(0, 'utf8')) as unknown);
console.log('Backend/frontend contracts match');
