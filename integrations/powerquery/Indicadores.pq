// Indicadores: dimensión. indicator_key = fuente:código, la clave que usa Observaciones.
let
    Origen = fnOdiGet(
        "v_indicator",
        [],
        "indicator_key,source_code,indicator_code,name_es,name_en,unit_label,category_code,dataset_code,license_code,source_organization,provider_last_updated",
        "indicator_key.asc"
    ),
    Tipos = Table.TransformColumnTypes(Origen, {{"provider_last_updated", type date}}),
    ConNombre = Table.AddColumn(
        Tipos,
        "nombre",
        each if [name_es] = null then [name_en] else [name_es],
        type text
    )
in
    ConNombre
