// Fuentes: catálogo de API con licencia y última prueba de disponibilidad.
let
    Origen = fnOdiGet(
        "v_source",
        [],
        "source_code,name,provider,status,restrictions,license_code,license_name,license_url,allows_commercial,share_alike,last_admission_at,last_admission_outcome,last_admission_http_status",
        "source_code.asc"
    ),
    Tipos = Table.TransformColumnTypes(Origen, {{"last_admission_at", type datetimezone}})
in
    Tipos
