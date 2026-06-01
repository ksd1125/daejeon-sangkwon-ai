# Microdata Build Notes

This build step adds two exploration layers without pretending that the current
district aggregates are observed store or block values.

## Inputs

1. Public Data Portal store DB CSV or store API collection
   - The file path can use the current `소상공인시장진흥공단_상가(상권)정보`
     download after extracting its CSV.
   - When only the API key is available, run `collect-store-api.js` first to
     build a Daejeon JSON store set from sigungu queries.
   - The microdata builder accepts either the extracted CSV or the JSON created
     by `collect-store-api.js`.
2. SGIS basic-unit GeoJSON
   - Download the `기초단위구 경계(시도)` SHP from SGIS 자료제공.
   - Keep the Daejeon features and export them to GeoJSON in longitude/latitude
     coordinates before running this script.
   - The SGIS 자료 page documents its downloadable boundary coordinate system
     as UTM-K EPSG:5179, so a WGS84 conversion is expected before web map use.

## Run

```powershell
cd C:\Users\sudon\Desktop\cowork\project\상권ai챗봇\app
node build\compile-microdata.js --stores "C:\data\store-db.csv" --basic-units "C:\data\daejeon-basic-units.geojson"
```

The API collector output can be used directly:

```powershell
node build\compile-microdata.js --stores data\micro\public-store-api-daejeon.json
```

## Store API collection

Put the Public Data Portal service key on the first non-comment line of:

```text
build\secrets\public-data-store-api-key.txt
```

Then run:

```powershell
node build\collect-store-api.js
```

The collector saves normalized Daejeon stores to
`data/micro/public-store-api-daejeon.json` and raw paged API responses to
`raw/store-api`. It queries Daejeon's five sigungu codes instead of
starting with a nationwide pull. For a quota-light check, use:

```powershell
node build\collect-store-api.js --max-pages 1
```

The default run generates the app's latest month. Use `--all-months` or
`--months 202601,202602` when a broader prototype is needed.

## Outputs

- `data/micro/stores-daejeon.synthetic.json`
  - Store name, source coordinates, address, matched app district and industry
  - Deterministic synthetic sales per matched month in manwon
- `data/micro/basic-units-footfall.synthetic.geojson`
  - SGIS basic-unit geometries assigned to an app district
  - Deterministic synthetic footfall per matched month
- `data/micro/microdata-manifest.json`
  - Input paths, row counts, assumptions, and preservation diagnostics

## Statistical contract

### Store sales

- The aggregate app record is still the authority.
- Public store DB rows define the observed point locations used for the map.
- For each district, industry, and month with matched store rows, the builder:
  1. creates deterministic lognormal weights,
  2. uses a wider dispersion for industries where business size tends to vary
     more,
  3. rescales and integer-rounds the weights so the synthetic store rows keep
     the district-industry-month mean exactly at the current aggregate mean.
- If the public store count and `upso` aggregate differ, the diagnostics keep
  both counts. The builder does not invent unnamed stores to hide the mismatch.

### Basic-unit footfall

- The aggregate district footfall remains the authority.
- Each SGIS basic-unit feature is assigned by an explicit administrative code
  when available, otherwise by its centroid inside the existing district
  GeoJSON.
- Within a district and month, area-weighted deterministic lognormal weights
  allocate footfall over the assigned basic units.
- The integer allocations are rescaled so the district-month total is
  preserved exactly.

## Fixture check

```powershell
node build\compile-microdata.js --stores build\fixtures\daejeon-store-db-sample.csv --basic-units build\fixtures\daejeon-basic-units-sample.geojson --out-dir build\fixtures\out
```

The fixture uses a tiny set of Central-dong store rows and two basic-unit
polygons only to test parsing, matching, deterministic allocation, and total
preservation.
