import type { InfinicusConfig } from '@infinicus/configuration';

type FastifyTrustProxy = boolean | string | string[] | ((address: string, hop: number) => boolean);

/**
 * Converts the validated TRUST_PROXY setting into a Fastify `trustProxy` value.
 *
 * A hop count N trusts the N proxies nearest the API; index 0 is the socket
 * peer (Caddy in the documented deployment). It is written as a function
 * because Fastify's typings omit the numeric form that its proxy-addr
 * dependency supports; the semantics (`hop < N`) are identical to that form.
 * With N = 1, request.ip is the address Caddy appended to X-Forwarded-For, and
 * anything a client put to its left in that header is ignored.
 */
export function resolveTrustProxy(setting: InfinicusConfig['trustProxy']): FastifyTrustProxy {
  if (typeof setting === 'number') {
    return (_address: string, hop: number) => hop < setting;
  }
  return setting;
}
