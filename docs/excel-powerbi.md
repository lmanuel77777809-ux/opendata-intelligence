# Excel y Power BI

Las consultas de `integrations/powerquery/` leen la API propia de OpenData Intelligence (nunca a
los proveedores), paginan solas y se pueden actualizar en el servicio de Power BI.

## Qué necesitas

- La URL del proyecto Supabase (`https://<proyecto>.supabase.co`).
- La **clave publicable** de Supabase (*Project Settings → API Keys*). Es de solo lectura y los
  permisos de la base protegen los datos. Nunca uses la clave `service_role` ni la secreta.

## Prueba rápida (una sola consulta)

Para comprobar la conexión antes de montar el modelo: **Datos → Obtener datos → Desde otras
fuentes → Consulta en blanco → Editor avanzado**, pega `PruebaRapida.pq`, cambia la URL y la clave
de las dos primeras líneas y pulsa **Listo**. Si pide acceso al contenido web: **Anónimo →
Conectar**. Devuelve el PIB y la población de 5 países, 2000–2024 (250 filas).

## Power BI Desktop

1. **Inicio → Transformar datos** para abrir el editor de Power Query.
2. **Nuevo origen → Consulta en blanco**. Abre el **Editor avanzado**, pega el contenido de
   `OdiBaseUrl.pq` y llama a la consulta `OdiBaseUrl`. Cambia la URL por la de tu proyecto.
3. Repite con `OdiApiKey.pq` (consulta `OdiApiKey`) y pega tu clave publicable.
4. Crea una consulta en blanco con `fnOdiGet.pq` y llámala exactamente `fnOdiGet`.
5. Crea `Indicadores`, `Geografias`, `Fuentes`, `Datasets` y `Observaciones` con sus ficheros.
6. Si pregunta por credenciales: **Anónimo**, nivel de privacidad **Organizativo**. La clave viaja
   en la cabecera `apikey`.
7. En `Observaciones` elige los indicadores (`IndicadoresElegidos`) y los años (`AnioDesde`,
   `AnioHasta`). Las claves están en la columna `indicator_key` de `Indicadores`.
8. **Cerrar y aplicar**.

## Excel (Microsoft 365)

**Datos → Obtener datos → Desde otras fuentes → Consulta en blanco**, y los mismos pasos 2 a 7.
Carga `Observaciones` como tabla o tabla dinámica, o solo como conexión al modelo de datos.

## Modelo recomendado

| Tabla | Tipo | Relación |
| --- | --- | --- |
| `Observaciones` | Hechos | — |
| `Indicadores` | Dimensión | `Indicadores[indicator_key]` 1 → * `Observaciones[indicator_key]` |
| `Geografias` | Dimensión | `Geografias[geo_key]` 1 → * `Observaciones[geo_key]` |
| `Fuentes` | Dimensión | `Fuentes[source_code]` 1 → * `Indicadores[source_code]` |
| `Datasets` | Monitor | Estado de actualización por dataset |

Para comparar años, crea una tabla de años y relaciónala con `Observaciones[year]`:

```DAX
Anios = SELECTCOLUMNS ( GENERATESERIES ( 1960, 2030, 1 ), "Anio", [Value] )

Valor = SUM ( Observaciones[value] )
Valor año anterior =
    CALCULATE ( [Valor], FILTER ( ALL ( Anios ), Anios[Anio] = MAX ( Anios[Anio] ) - 1 ) )
Variación % = DIVIDE ( [Valor] - [Valor año anterior], [Valor año anterior] )
```

`Valor` suma: úsalo con un solo indicador en el contexto (filtro o segmentador). Sumar tasas,
porcentajes o agregados regionales con países da cifras sin sentido.

Muestra siempre la fuente y la licencia (`license_code`, `Fuentes[license_name]`): las licencias
exigen atribución.

## Actualización

- En Desktop y Excel: **Actualizar**.
- En el servicio de Power BI: publica el informe y configura la actualización programada.
  La URL base es fija y la ruta va en `RelativePath`, así que el servicio la acepta sin puerta de
  enlace. Credenciales del origen: **Anónimo**.
- Los datos de la API se renuevan según la frecuencia de cada dataset (ver consulta `Datasets`).

## Problemas frecuentes

| Mensaje | Solución |
| --- | --- |
| `La API respondió HTTP 401` | Revisa `OdiApiKey` (clave publicable completa) |
| `La API respondió HTTP 406` | El esquema `api` no está expuesto en Supabase (ver `docs/supabase-setup.md`) |
| `La API respondió HTTP 404` | Nombre de vista mal escrito en una consulta |
| Tabla vacía | El indicador no existe o su fuente todavía no está aprobada (`Indicadores`) |
| «Este origen de datos dinámico no se puede actualizar» | Usa `fnOdiGet` tal cual: no construyas la URL concatenando texto |

## Verificación

- La sintaxis M de las ocho consultas se valida en CI con el analizador oficial de Microsoft
  (`@microsoft/powerquery-parser`).
- Las mismas peticiones HTTP que generan (filtros, orden, `limit`/`offset`) se prueban contra
  PostgREST con datos sintéticos y con los datos reales del Banco Mundial.
- Falta la prueba dentro de Excel y Power BI, que solo puede hacerse en Windows.
