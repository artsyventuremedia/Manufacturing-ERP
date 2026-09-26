import { ValidationError } from '@manuling/kernel';

type HeaderValue = string | string[] | undefined;

function single(value: HeaderValue): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/** `{slug}.{baseDomain}` → slug. Only one label is accepted, so `a.b.example.in` is ignored. */
export function slugFromHost(
  host: string | undefined,
  baseDomain: string | undefined,
): string | undefined {
  if (!host || !baseDomain) return undefined;
  const hostname = host.toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const label = hostname.slice(0, -suffix.length);
  return label && !label.includes('.') ? label : undefined;
}

/**
 * Determines which workspace a request targets: the `X-Tenant` header (API clients, dev) or
 * the subdomain (web app). Membership is verified afterwards, so this is not a security check.
 */
export function resolveTenantSlug(
  headers: Readonly<Record<string, HeaderValue>>,
  baseDomain: string | undefined,
): string {
  const fromHeader = single(headers['x-tenant']);
  const fromHost = slugFromHost(single(headers['host']), baseDomain);
  if (fromHeader && fromHost && fromHeader !== fromHost) {
    throw new ValidationError(
      'http.tenant_ambiguous',
      'X-Tenant does not match the workspace subdomain',
    );
  }
  const slug = fromHeader ?? fromHost;
  if (!slug) {
    throw new ValidationError(
      'http.tenant_required',
      'Specify the workspace with the X-Tenant header or its subdomain',
    );
  }
  return slug;
}
