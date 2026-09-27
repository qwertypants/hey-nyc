# Basemap choice

**Chosen: [OpenFreeMap](https://openfreemap.org) `positron` style, served from
`https://tiles.openfreemap.org/styles/positron`.**

Verified live on 2026-09-27.

## Why

The brief rules out Mapbox, Google, and anything needing a proprietary account or API key.
That leaves very few options that are simultaneously free at production traffic, keyless,
and properly licensed. OpenFreeMap is the only one measured here that meets all three.

| Requirement | OpenFreeMap |
| --- | --- |
| API key | none |
| Registration | none |
| Rate limit | none — "no limits on the number of map views or requests" |
| Cost | free; the public instance is donation-funded |
| Software licence | MIT |
| Map data | OpenStreetMap, ODbL |
| Self-hostable | yes — full planet Btrfs/PMTiles images published |

Protomaps was the other candidate. It is a strong option but its hosted daily tiles and
its free API tier both want you to register and configure a key, and Protomaps' own
positioning is that the hosted service is a paid product. That is a worse fit for a
zero-config, fork-and-deploy open-source project.

`demotiles.maplibre.org` is explicitly rejected: the brief forbids it, and rightly — it is
a low-traffic documentation endpoint with no availability guarantee.

## Attribution

The `openmaptiles` source in the style is declared as a TileJSON **URL**, and MapLibre
reads `attribution` from that TileJSON. Confirmed present at
`https://tiles.openfreemap.org/planet`:

```
<a href="https://openfreemap.org">OpenFreeMap</a>
<a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a>
Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>
```

So attribution is **automatic** as long as we point the map at the published style URL and
do not hand-roll a style. Do not inline a copy of the style JSON into the repo — that is
what would drop the attribution.

`Eat Outside NYC` also renders its own visible attribution string and must keep the
NYC Open Data / NYC DOT credit on screen. Both credits are required; they are separate
obligations from separate data sources.

The app declares `customAttribution` on the MapLibre map for the NYC Open Data credit, and
shows the "Data updated …" line from `metadata.json` — never a hard-coded date.

## Known limitations — read this before swapping the basemap

1. **`maxzoom` is 14.** The TileJSON reports `maxzoom: 14`, and the source is
   `https://tiles.openfreemap.org/planet` (OpenMapTiles schema). Past zoom 14 MapLibre
   overzooms z14 tiles. On a dining map a user *will* zoom to z16–17 to find one specific
   café, and the street layer will be soft there.
   Mitigations in the MVP: the `positron` style is deliberately low-contrast so softness
   is less visible, and the app caps maximum zoom at 16. If street-level crispness turns
   out to matter, move to a self-hosted Protomaps PMTiles build — the app is wired for
   that with no code change (see below).

2. **The public instance is a community resource.** OpenFreeMap states it "aim[s] to
   cover the running costs of our public instance through donations". There is no SLA and
   no contractual availability. A fork that needs a guarantee should self-host.

3. **Shaded relief** (`ne2_shaded` in the style) is decorative and adds weight. The app
   does not depend on it.

## Swapping the basemap

The style URL is read from an environment variable, defaulting to OpenFreeMap:

```bash
VITE_BASEMAP_STYLE_URL=https://example.org/style.json npm run build
```

`VITE_BASEMAP_STYLE_URL` is the single seam. Self-hosting Protomaps, an OpenFreeMap
planet build, or any MapLibre style JSON all work through it. Nothing else in the app
assumes a particular basemap — the layer stack in `src/map/layers.ts` only touches the
GeoJSON source we control.

## Geocoding

Search geocoding is a separate concern from the basemap and is handled in
`docs/data-pipeline.md` and `src/lib/geocode.ts`. The MVP uses **Nominatim** with explicit
user-initiated submission, a 1 request/second floor, and an NYC bounding box bias. Per
Nominatim's usage policy there is deliberately **no keystroke-by-keystroke autocomplete
against the public endpoint**; pressing Enter is the only trigger.
