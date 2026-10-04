import { validateArtifacts, validateBoundaries, validateMetadata } from './validate';
import type { StorefrontBoundaryCollection, StorefrontMetadata } from '../../types/storefronts';
/** Lazy cohort publication; see docs/adr/0010-load-storefront-reports-by-period.md. */
export type LoadedStorefronts = ReturnType<typeof validateArtifacts>;
export const STOREFRONT_PATHS = ['metadata.json', 'boundaries.geojson', 'areas.json', 'vacant.geojson'] as const;
interface LoadOptions { fetchImpl?: typeof fetch; baseUrl?: string }
let shared: Promise<{ metadata: StorefrontMetadata; boundaries: StorefrontBoundaryCollection }> | null = null;
const cohorts = new Map<string, Promise<LoadedStorefronts>>();
export function resetStorefrontCache(): void { shared = null; cohorts.clear(); }
async function fetchArtifact(path: string, options: LoadOptions): Promise<unknown> {
  const base = options.baseUrl ?? import.meta.env.BASE_URL ?? '/';
  const response = await (options.fetchImpl ?? fetch)(`${base.replace(/\/?$/, '/')}data/storefronts/${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Storefront ${path} failed (${response.status})`);
  return await response.json() as unknown;
}
async function loadShared(options: LoadOptions) {
  const [metadata, boundaries] = await Promise.all([fetchArtifact('metadata.json', options), fetchArtifact('boundaries.geojson', options)]);
  return { metadata: validateMetadata(metadata), boundaries: validateBoundaries(boundaries) };
}
export function loadStorefrontSharedOnce(options: LoadOptions = {}) {
  shared ??= loadShared(options);
  return shared;
}
export async function loadStorefronts(year = '2024', options: LoadOptions = {}): Promise<LoadedStorefronts> {
  const common = await loadStorefrontSharedOnce(options);
  const period = common.metadata.periodArtifacts.find((p) => p.reportingYear === year);
  if (!period) throw new Error(`Storefront reporting label ${year} is not published`);
  const [areas, vacant] = await Promise.all([fetchArtifact(period.areasPath, options), fetchArtifact(period.vacantPath, options)]);
  return validateArtifacts(common.metadata, areas, vacant, common.boundaries, year);
}
export function loadStorefrontsOnce(year = '2024', options: LoadOptions = {}): Promise<LoadedStorefronts> {
  let pending = cohorts.get(year);
  if (!pending) { pending = loadStorefronts(year, options); cohorts.set(year, pending); }
  return pending;
}
