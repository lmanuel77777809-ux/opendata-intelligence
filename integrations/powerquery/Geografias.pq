// Geografías: países y agregados. geo_key = tipo:código, la clave que usa Observaciones.
let
    Origen = fnOdiGet("v_geo", [], "geo_kind,geo_code,iso2,name_es,name_en,defined_by_source", "geo_kind.asc,geo_code.asc"),
    ConClave = Table.AddColumn(Origen, "geo_key", each [geo_kind] & ":" & [geo_code], type text),
    ConNombre = Table.AddColumn(
        ConClave,
        "nombre",
        each if [name_es] = null then [name_en] else [name_es],
        type text
    )
in
    ConNombre
