import { describe, expect, it, vi } from 'vitest';
import { createFakeMap } from './helpers/fakeMap';
import { fixtureIndex } from './helpers/walkMap';
import { FIXTURES, makeCollection } from './helpers/fixtures';
import { addEatLayers, removeEatLayers } from '../src/features/eat/layers';
import { mountWalkLayers, unmountWalkLayers } from '../src/features/walk/layers';
import { mountStorefrontLayers } from '../src/features/storefronts/layers';
import { DEFAULT_STOREFRONT_FILTERS } from '../src/features/storefronts/filters';
import { sfArtifacts } from './storefront-fixtures';
vi.mock('maplibre-gl', () => ({ default: { Map: vi.fn() } }));
import { ATTRIBUTION_CONTROL_OPTIONS } from '../src/map/createMap';
describe('map data credits follow active feature sources', () => {
  it('keeps basemap attribution enabled without a permanent Eat-only custom credit', () => {
    expect(ATTRIBUTION_CONTROL_OPTIONS.compact).toBe(false);
    expect(ATTRIBUTION_CONTROL_OPTIONS).not.toHaveProperty('customAttribution');
  });
  it('credits each dataset only on its own sources as modes switch', () => {
    const fake = createFakeMap(); const add = vi.spyOn(fake.map, 'addSource');
    addEatLayers(fake.map, makeCollection(FIXTURES), { type: 'all', borough: 'all' });
    expect(add.mock.calls[0]?.[1]).toMatchObject({ attribution: expect.stringContaining('fpeh-f7ci') });
    removeEatLayers(fake.map); add.mockClear();
    mountWalkLayers(fake.map, fixtureIndex());
    expect(add.mock.calls[0]?.[1]).toMatchObject({ attribution: expect.stringContaining('cqsj-cfgu') });
    expect(add.mock.calls[1]?.[1]).toMatchObject({ attribution: expect.stringContaining('ct66-47at') });
    unmountWalkLayers(fake.map); add.mockClear();
    const handle = mountStorefrontLayers(fake.map, sfArtifacts(), DEFAULT_STOREFRONT_FILTERS, () => null);
    expect(add.mock.calls[0]?.[1]).toMatchObject({ attribution: expect.stringContaining('9nt8-h7nd') });
    expect(add.mock.calls[1]?.[1]).toMatchObject({ attribution: expect.stringContaining('92iy-9c3n') });
    expect(add.mock.calls.some(([, source]) => JSON.stringify(source).includes('fpeh-f7ci'))).toBe(false);
    handle.destroy(); expect(fake.sourceIds()).toEqual([]);
  });
});
