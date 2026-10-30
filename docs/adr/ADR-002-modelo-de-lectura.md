# ADR-002: Modelo de lectura de la API pública

- Estado: aceptada (Sprint 2, 2026-10-31). Sustituye la parte de ADR-001 que exponía vistas
  `security_invoker` con RLS para el público.

## Contexto

Con datos reales (163.525 observaciones), `api.get_series` tardaba 101 ms para 75 filas. Con
volumen sintético equivalente, la misma consulta tardaba 1 ms como superusuario y 60–100 ms como
`anon`. Las políticas RLS anidadas (observación → serie → indicador → dataset → fuente) se
evaluaban fila a fila y, como barrera de seguridad, impedían aplicar antes el filtro de geografía.
El coste crece linealmente con el volumen.

## Decisión

1. Las vistas de `api` pertenecen a `api_reader`, un rol sin login que solo puede leer las tablas
   que las vistas necesitan (con políticas `using (true)` para ese rol).
2. Cada vista aplica explícitamente la regla de visibilidad: fuente `approved`,
   `approved_restricted` o `quarantined` y dataset público; las observaciones, además, no retiradas.
3. Las vistas llevan `security_barrier = true`: ningún filtro del usuario se evalúa antes que la
   regla de visibilidad.
4. `anon` y `authenticated` pierden todo acceso a las tablas y esquemas internos; solo leen `api`.
5. `core.series.geo_code` y `core.indicator.indicator_key` se almacenan e indexan. Los códigos de
   los que salen (ISO3, código de región, código de fuente, código de indicador) son inmutables.

## Consecuencias

- Medido en CI con datos reales: vista filtrada 0,16 ms y `get_series` 1,4 ms (antes 101 ms).
- Menos superficie: el público no puede leer ninguna tabla, aunque se expusiera otro esquema.
- El linter de Supabase avisará de vistas sin `security_invoker`. Es intencionado: la regla de
  visibilidad está en la vista y la prueban `db/test/03_security.test.sql` y el contrato REST.
- Una regla de visibilidad nueva debe añadirse en las vistas, no en políticas RLS para `anon`.
