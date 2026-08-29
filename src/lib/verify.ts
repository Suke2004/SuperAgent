/**
 * Running a profile's connection test, and acting on what it found.
 *
 * The test is not just a green tick: its `GET /models` step is the only model list
 * this app ever gets, and its failure kinds are the only honest evidence about
 * whether the host is reachable. So every caller has to do the same four things
 * afterwards — record the outcome on the profile, update reachability, ingest the
 * discovered models, and correct a `defaultModel` the gateway does not serve.
 *
 * That was written once, in the provider detail screen, which meant saving a key
 * from the setup form left all four undone: no models, no reachability, and a seeded
 * default model that may well 404 on the first message. Hence this module — the
 * screens keep their own presentation, and share the part that has consequences.
 */

import { MissingKeyError, invalidateTransports, resolveTransport } from '@/lib/gateway';
import { log } from '@/lib/log';
import { useModels } from '@/stores/models';
import { adoptDiscoveredModel, useProviders } from '@/stores/providers';
import { useReachability } from '@/stores/reachability';
import { summariseFailure } from '@/transports';
import { GatewayError } from '@/transports/errors';
import type { ConnectionTestResult } from '@/transports/types';

export interface VerifyResult {
  outcome: ConnectionTestResult;
  /** The model discovery switched the profile to, or `null` if nothing changed. */
  adopted: string | null;
  /** How many models the list step added to the registry. */
  discovered: number;
}

/**
 * Tests a profile and folds the result back into the stores.
 *
 * Never throws: a missing key and a dead host are both reportable outcomes, and a
 * caller that has to wrap this in a try/catch to show them ends up describing them
 * differently from the caller next door. Failures come back as a `ConnectionTestResult`
 * with one failed step, in the same shape the transport itself would have produced.
 */
export async function verifyProfile(profileId: string, signal?: AbortSignal): Promise<VerifyResult> {
  const profile = useProviders.getState().byId(profileId);
  if (!profile) {
    return {
      outcome: { ok: false, steps: [], summary: 'That profile no longer exists.' },
      adopted: null,
      discovered: 0,
    };
  }

  try {
    const { transport } = await resolveTransport({ profileId });
    const outcome = await transport.testConnection(signal);
    useProviders.getState().recordTest(profileId, outcome.ok, outcome.summary);

    // A test that got an answer — even a 401 — is proof the host is reachable, and
    // the strongest such proof this app produces on purpose. A test that failed to
    // connect is the opposite, and `testConnection` reports that in a step rather
    // than by throwing, so the steps have to be read.
    const unreachable = outcome.steps.find((step) => step.error?.kind === 'network');
    if (unreachable) {
      useReachability
        .getState()
        .markUnreachable(unreachable.detail ?? unreachable.error?.message ?? '', profile.baseUrl);
    } else {
      useReachability.getState().markReachable();
    }

    let adopted: string | null = null;
    let discovered = 0;
    if (outcome.models?.length) {
      const { added } = useModels.getState().ingest(profileId, outcome.models);
      discovered = added.length;
      if (added.length) {
        log.info('models', `Discovered ${added.length} new model(s) on ${profile.name}.`);
      }
      // The seeded default is a guess. If the gateway does not serve it, point the
      // profile at something it does — leaving it alone means every message from
      // here fails with a permission error.
      adopted = adoptDiscoveredModel(
        profileId,
        outcome.models.map((model) => model.id),
      );
      if (adopted) {
        invalidateTransports(profileId);
        log.info('models', `Default model for ${profile.name} set to ${adopted}.`);
      }
    }

    return { outcome, adopted, discovered };
  } catch (error) {
    // A missing key is a real, reportable outcome — not a reason to grey a button
    // out. Report it in the same shape as a gateway failure.
    const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
    const outcome: ConnectionTestResult = {
      ok: false,
      steps: [
        {
          label: error instanceof MissingKeyError ? 'API key' : 'Request',
          status: 'failed',
          detail: gatewayError.message,
          error: gatewayError,
        },
      ],
      summary: summariseFailure(gatewayError),
    };
    useProviders.getState().recordTest(profileId, false, outcome.summary);
    if (gatewayError.kind === 'network') {
      useReachability.getState().markUnreachable(gatewayError.message, profile.baseUrl);
    } else if (!(error instanceof MissingKeyError)) {
      // Anything else came back *from* the gateway, so the host answered.
      useReachability.getState().markReachable();
    }
    return { outcome, adopted: null, discovered: 0 };
  }
}
