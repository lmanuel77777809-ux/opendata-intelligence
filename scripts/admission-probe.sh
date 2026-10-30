#!/usr/bin/env bash
# Prueba de admisión de las 17 fuentes candidatas (Fase 0): GET anónimo, sin cabeceras de
# autenticación. Guarda cabeceras, cuerpo y un resumen TSV por endpoint.
#   bash scripts/admission-probe.sh [directorio_salida]
# Resultado por línea: id, HTTP, content-type, segundos, bytes, redirecciones, URL.
# HTTP 000 = sin respuesta del proveedor (red bloqueada, DNS o timeout): ver <id>.err.
set -uo pipefail

OUT="${1:-admission-results/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
UA="OpenDataIntelligence-Admission/0.1 (+https://github.com/lmanuel77777809-ux/opendata-intelligence${ODI_CONTACT:+; contact: $ODI_CONTACT})"
enc() { python3 -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

probe() {
  local id="$1" url="$2" accept="${3:-*/*}" w
  w=$(curl -sS -L --max-redirs 3 --max-time 60 -A "$UA" -H "Accept: $accept" \
      -D "$OUT/$id.hdr" -o "$OUT/$id.body" \
      -w '%{http_code}\t%{content_type}\t%{time_total}\t%{size_download}\t%{num_redirects}' "$url" 2>"$OUT/$id.err")
  printf '%s\t%s\t%s\n' "$id" "$w" "$url" | tee -a "$OUT/summary.tsv"
  sleep 1.2
}

: > "$OUT/summary.tsv"
# World Bank
probe wb_data      'https://api.worldbank.org/v2/country/ESP/indicator/NY.GDP.MKTP.CD?format=json&per_page=5'
probe wb_indicators 'https://api.worldbank.org/v2/indicator?format=json&per_page=1'
probe wb_countries 'https://api.worldbank.org/v2/country?format=json&per_page=1'
probe wb_sources   'https://api.worldbank.org/v2/sources?format=json&per_page=100'
probe wb_hist      'https://api.worldbank.org/v2/country/ESP/indicator/SP.POP.TOTL?format=json&per_page=100&date=1960:1965'
# Our World in Data (Chart API)
probe owid_csv     'https://ourworldindata.org/grapher/life-expectancy.csv?v=1&csvType=filtered&useColumnShortNames=true&country=~ESP'
probe owid_meta    'https://ourworldindata.org/grapher/life-expectancy.metadata.json?v=1&csvType=full&useColumnShortNames=true'
# GLEIF
probe gleif_list   'https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=2&page%5Bnumber%5D=1'
probe gleif_search 'https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=Banco%20Santander&page%5Bsize%5D=2'
# Wikidata
Q='SELECT ?war ?warLabel ?start ?end WHERE { ?war wdt:P31 wd:Q198; wdt:P580 ?start. OPTIONAL { ?war wdt:P582 ?end } SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". } } ORDER BY ?start LIMIT 5'
probe wd_sparql    "https://query.wikidata.org/sparql?format=json&query=$(enc "$Q")" 'application/sparql-results+json'
probe wd_action    'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q12560&props=labels|claims&languages=es&format=json'
probe wd_rest      'https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/Q12560/labels'
# Jolpica F1
probe jolpica_res  'https://api.jolpi.ca/ergast/f1/2024/1/results.json?limit=3'
probe jolpica_seas 'https://api.jolpi.ca/ergast/f1/seasons.json?limit=1'
# IMF
probe imf_dm_ind   'https://www.imf.org/external/datamapper/api/v1/indicators'
probe imf_dm_data  'https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/ESP'
probe imf_sdmx     'https://api.imf.org/external/sdmx/2.1/dataflow/IMF.STA/CPI' 'application/xml'
# OECD
probe oecd_flow    'https://sdmx.oecd.org/public/rest/dataflow/OECD.SDD.TPS/DSD_PRICES@DF_PRICES_ALL/latest' 'application/vnd.sdmx.structure+xml; version=2.1'
probe oecd_data    'https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,/ESP.M.N.CPI.PA._T.N.GY?startPeriod=2025-01&dimensionAtObservation=AllDimensions' 'application/vnd.sdmx.data+json; charset=utf-8; version=2'
# ECB
probe ecb_exr      'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=jsondata&lastNObservations=3'
# Eurostat
probe estat_gdp    'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_gdp?geo=ES&unit=CP_MEUR&na_item=B1GQ&lastTimePeriod=3&format=JSON&lang=EN'
# DBpedia
DQ='SELECT ?e ?label WHERE { ?e a dbo:MilitaryConflict ; rdfs:label ?label . FILTER(lang(?label)="es") } LIMIT 3'
probe dbpedia_sparql "https://dbpedia.org/sparql?format=application%2Fsparql-results%2Bjson&query=$(enc "$DQ")" 'application/sparql-results+json'
# WorldPop
probe worldpop_cat 'https://www.worldpop.org/rest/data'
probe worldpop_ds  'https://www.worldpop.org/rest/data/pop/wpgp?iso3=ESP'
GJ='{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[-3.75,40.38],[-3.65,40.38],[-3.65,40.46],[-3.75,40.46],[-3.75,40.38]]]}}]}'
probe worldpop_stats "https://api.worldpop.org/v1/services/stats?dataset=wpgppop&year=2020&geojson=$(enc "$GJ")&runasync=false"
# UN Population Data Portal
probe unpop_ind    'https://population.un.org/dataportalapi/api/v1/indicators?pageSize=2'
probe unpop_data   'https://population.un.org/dataportalapi/api/v1/data/indicators/49/locations/724/start/2020/end/2022'
# SEC EDGAR (UA without contact email on purpose; SEC asks for one)
probe sec_subm     'https://data.sec.gov/submissions/CIK0000320193.json'
probe sec_concept  'https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/AccountsPayableCurrent.json'
# OpenLigaDB
probe olig_leagues 'https://api.openligadb.de/getavailableleagues'
probe olig_matches 'https://api.openligadb.de/getmatchdata/bl1/2023/1'
# MusicBrainz
probe mb_artist    'https://musicbrainz.org/ws/2/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da?fmt=json&inc=release-groups'
sleep 1
probe mb_search    'https://musicbrainz.org/ws/2/artist/?query=artist:queen%20AND%20country:GB&limit=2&fmt=json'
# Alternative candidates (demography/health)
probe who_gho      "https://ghoapi.azureedge.net/api/WHOSIS_000001?\$filter=SpatialDim%20eq%20'ESP'&\$top=3"
probe unsd_sdg     'https://unstats.un.org/sdgapi/v1/sdg/Series/List?allreleases=false'
echo "Resultados en $OUT/summary.tsv"
