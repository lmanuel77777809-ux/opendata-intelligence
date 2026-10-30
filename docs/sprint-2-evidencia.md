# Sprint 2 — Evidencia

Fecha: 2026-10-30. Pruebas reales en GitHub Actions (`ubuntu-24.04`, PostgreSQL 16, PostgREST v12.2.3).

**Resultado:** la API pública está construida y probada por HTTP con el mismo software que usa
Supabase (PostgREST), con datos sintéticos y con los 163.525 datos reales del Banco Mundial. La
consulta pública pasó de 101 ms a 1–3 ms. Las consultas de Excel/Power BI están escritas y su
sintaxis y sus peticiones están verificadas. **Falta el proyecto Supabase**: el despliegue y la
ingesta programada están listos pero sin ejecutar, y la prueba dentro de Excel/Power BI debe
hacerla el usuario en Windows.

Ejecuciones de referencia:
[CI](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/40994898416) ·
[Validación con API reales](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/40994898411)

## Criterios de salida del Sprint 2

| Criterio | Estado | Evidencia |
| --- | --- | --- |
| Lectura anónima correcta por la API | Cumplido en PostgREST; **pendiente en Supabase** | Contrato REST: 9 de 9 (sintéticos), 8 de 9 (reales, 1 omitida por ser solo para sintéticos) |
| Escritura rechazada | Cumplido en PostgREST; pendiente en Supabase | POST y DELETE devuelven error; tablas y esquemas internos, 404/406 |
| Consulta paginada de Power Query | Cumplido fuera de Excel | Sintaxis M válida (analizador oficial); la URL exacta que genera devuelve los datos filtrados |
| Refresco en Excel y Power BI | **Pendiente del usuario** | Requiere Windows |
| Rendimiento de la consulta pública | Cumplido | Tabla siguiente |

## Rendimiento

Consulta: PIB de ESP, FRA y DEU, 2000–2024 (75 filas), como `anon`, con 163.525 observaciones
reales. Mediana de 5 ejecuciones.

| Consulta | Sprint 1 | Sprint 2 |
| --- | --- | --- |
| `api.get_series` (RPC) | 101 ms | 1,4–2,6 ms |
| `v_observation` filtrada (lo que pide Power Query) | — | 0,16–0,28 ms |

Los rangos recogen dos ejecuciones de CI en máquinas distintas. Con volumen sintético
equivalente en local, la vista filtrada pasó de 61–99 ms a 0,6 ms.

**Causa y solución** ([ADR-002](adr/ADR-002-modelo-de-lectura.md)): las políticas RLS anidadas
se evaluaban fila a fila e impedían filtrar antes por geografía. Ahora las vistas pertenecen a
un rol de solo lectura, `api_reader`, y aplican ellas la regla de visibilidad con
`security_barrier`. Además, el público ya no puede leer ninguna tabla, y las claves `geo_code` e
`indicator_key` están almacenadas e indexadas.

## Pruebas ejecutadas

| Suite | Resultado |
| --- | --- |
| Tipos | Sin errores |
| Unitarias | 40 de 40 (SDK 21, Banco Mundial 8, Power Query 11) |
| SQL | 41 de 41 aserciones (modelo de lectura, aprobación registrada y registro de cambios inmutable) |
| Integración worker + PostgreSQL | 9 de 9 |
| Contrato REST, datos sintéticos | 9 de 9 |
| Contrato REST, datos reales | 8 de 9 (1 omitida a propósito) |
| Migraciones | 11 aplicadas desde cero; la segunda pasada aplica 0 |
| Carga real del Banco Mundial | 12 de 12 conteos y 20 de 20 muestras siguen cuadrando |

### Hallazgos durante el sprint

- **Permisos de funciones:** la prueba de esquema detectó 3 funciones nuevas ejecutables por
  `PUBLIC`. El `ALTER DEFAULT PRIVILEGES` por esquema de la primera migración no tenía efecto
  (PostgreSQL no permite quitar por esquema un permiso global). Se eliminó y cada migración revoca
  explícitamente.
- **Prueba de contrato errónea:** una aserción mía comparaba el total con la primera página; con
  datos reales el total supera 1000 filas y falló. Corregida; los fallos de contrato se publican
  ahora como anotaciones.

## Preparado, sin ejecutar (falta Supabase)

| Pieza | Estado |
| --- | --- |
| `scripts/migrate.sh` | Probado en local y en CI; registro compatible con el CLI de Supabase |
| Workflow **Desplegar base de datos** | Listo; sin `SUPABASE_DB_URL` termina sin hacer nada |
| Workflow **Ingesta programada** | Listo (diario, 05:17 UTC); sin `INGEST_DATABASE_URL` termina sin hacer nada |
| Guía de puesta en marcha | [supabase-setup.md](supabase-setup.md) |

## Decisión registrada

El 2026-10-30 el responsable del proyecto aprobó publicar el Banco Mundial. Queda en la migración
`20261030004000_approve_worldbank.sql`, con la evidencia y la licencia (CC BY 4.0, atribución
obligatoria), y en el nuevo registro `meta.catalog_change`, que guarda cada cambio de estado de
una fuente o de publicación de un dataset con su motivo, fecha y autor, y no admite ediciones.

## Corrección posterior (30-10-2026)

La auditoría detectó que este documento, ADR-002, la aprobación del Banco Mundial y tres
migraciones usaban la fecha 31-10-2026, posterior a la real. Se corrigió a 30-10-2026 y las
migraciones pasaron de `20261031000100`–`000300` a `20261030002000`–`004000`, antes de aplicarse
en ninguna base persistente. El despliegue en Supabase pasó a ser solo manual.

## Pendiente

1. Crear el proyecto Supabase y sus secretos ([supabase-setup.md](supabase-setup.md)).
2. Desplegar, cargar el Banco Mundial y repetir el contrato REST contra Supabase.
4. Probar las consultas en Excel y Power BI ([excel-powerbi.md](excel-powerbi.md)).
