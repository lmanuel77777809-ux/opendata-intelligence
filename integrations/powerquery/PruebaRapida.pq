// PruebaRapida: una sola consulta para comprobar la conexión desde Excel o Power BI.
// Cambia las dos primeras líneas por la URL del proyecto (sin "/rest/v1" al final) y la clave
// PUBLICABLE de Supabase.
// Para el modelo completo (indicadores, geografías, fuentes) usa las demás consultas de esta carpeta.
let
    Url = "https://TU-PROYECTO.supabase.co",
    Clave = "PEGAR_AQUI_LA_CLAVE_PUBLICABLE",
    Indicadores = {"worldbank:NY.GDP.MKTP.CD", "worldbank:SP.POP.TOTL"},
    Paises = {"ESP", "MEX", "USA", "COL", "ARG"},
    AnioDesde = 2000,
    AnioHasta = 2024,
    TamanoPagina = 1000,
    LeerPagina = (desplazamiento as number) as list =>
        Json.Document(
            Web.Contents(
                Url,
                [
                    RelativePath = "rest/v1/v_observation",
                    Query = [
                        select = "indicator_key,geo_code,geo_name,year,value,license_code",
                        indicator_key = "in.(" & Text.Combine(Indicadores, ",") & ")",
                        geo_code = "in.(" & Text.Combine(Paises, ",") & ")",
                        #"and" = "(year.gte." & Text.From(AnioDesde) & ",year.lte." & Text.From(AnioHasta) & ")",
                        order = "indicator_key.asc,geo_code.asc,year.asc",
                        limit = Text.From(TamanoPagina),
                        offset = Text.From(desplazamiento)
                    ],
                    Headers = [apikey = Clave, #"Accept-Profile" = "api", Accept = "application/json"]
                ]
            )
        ),
    Paginas = List.Generate(
        () => [desplazamiento = 0, filas = LeerPagina(0)],
        each List.Count([filas]) > 0,
        each [
            desplazamiento = [desplazamiento] + TamanoPagina,
            filas = if List.Count([filas]) < TamanoPagina then {} else LeerPagina([desplazamiento] + TamanoPagina)
        ],
        each [filas]
    ),
    Tabla = Table.FromRecords(List.Combine(Paginas), null, MissingField.UseNull),
    Tipos = Table.TransformColumnTypes(Tabla, {{"year", Int64.Type}, {"value", type number}})
in
    Tipos
