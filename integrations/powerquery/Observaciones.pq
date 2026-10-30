// Observaciones: tabla de hechos. Ajusta indicadores y período (claves en la consulta Indicadores).
let
    IndicadoresElegidos = {"worldbank:NY.GDP.MKTP.CD", "worldbank:SP.POP.TOTL", "worldbank:SP.DYN.LE00.IN"},
    AnioDesde = 1990,
    AnioHasta = 2025,
    Filtros = [
        indicator_key = "in.(" & Text.Combine(IndicadoresElegidos, ",") & ")",
        #"and" = "(year.gte." & Text.From(AnioDesde) & ",year.lte." & Text.From(AnioHasta) & ")"
    ],
    Origen = fnOdiGet(
        "v_observation",
        Filtros,
        "indicator_key,geo_kind,geo_code,geo_name,frequency,period_label,period_start,year,value,obs_status,license_code,updated_at",
        "indicator_key.asc,geo_kind.asc,geo_code.asc,frequency.asc,period_start.asc"
    ),
    Tipos = Table.TransformColumnTypes(
        Origen,
        {
            {"year", Int64.Type},
            {"period_start", type date},
            {"value", type number},
            {"updated_at", type datetimezone}
        }
    ),
    ConClaveGeo = Table.AddColumn(Tipos, "geo_key", each [geo_kind] & ":" & [geo_code], type text)
in
    ConClaveGeo
