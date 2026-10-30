// fnOdiGet: descarga todas las filas de una vista de la API de OpenData Intelligence, página a página.
//   vista    "v_observation", "v_indicator", "v_geo", "v_source" o "v_dataset"
//   filtros  registro de filtros de PostgREST, p. ej. [indicator_key = "eq.worldbank:SP.POP.TOTL"]
//   columnas columnas separadas por comas, o null para todas
//   orden    columnas que identifican cada fila, para que la paginación sea estable
// URL base fija + RelativePath/Query: así el informe se puede actualizar en el servicio de Power BI.
(vista as text, filtros as record, columnas as nullable text, orden as text) as table =>
let
    TamanoPagina = 1000,
    Cabeceras = [apikey = OdiApiKey, #"Accept-Profile" = "api", Accept = "application/json"],
    ConsultaBase = Record.Combine({
        [select = if columnas = null then "*" else columnas, order = orden],
        filtros
    }),
    LeerPagina = (desplazamiento as number) as list =>
        let
            Respuesta = Web.Contents(
                OdiBaseUrl,
                [
                    RelativePath = "rest/v1/" & vista,
                    Query = Record.Combine({
                        ConsultaBase,
                        [limit = Text.From(TamanoPagina), offset = Text.From(desplazamiento)]
                    }),
                    Headers = Cabeceras,
                    ManualStatusHandling = {400, 401, 403, 404, 406, 416, 500, 503}
                ]
            ),
            Estado = Value.Metadata(Respuesta)[Response.Status],
            Filas =
                if Estado = 200 or Estado = 206 then
                    Json.Document(Respuesta)
                else
                    error Error.Record(
                        "OpenData Intelligence",
                        "La API respondió HTTP " & Text.From(Estado) & " al leer " & vista,
                        Text.FromBinary(Respuesta)
                    )
        in
            Filas,
    Paginas = List.Generate(
        () => [desplazamiento = 0, filas = LeerPagina(0)],
        each List.Count([filas]) > 0,
        each [
            desplazamiento = [desplazamiento] + TamanoPagina,
            filas = if List.Count([filas]) < TamanoPagina then {} else LeerPagina([desplazamiento] + TamanoPagina)
        ],
        each [filas]
    ),
    Registros = List.Combine(Paginas),
    Tabla =
        if List.IsEmpty(Registros) then
            #table(if columnas = null then {} else Text.Split(columnas, ","), {})
        else
            Table.FromRecords(Registros, null, MissingField.UseNull)
in
    Tabla
