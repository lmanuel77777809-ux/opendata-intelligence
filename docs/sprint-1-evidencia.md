# Sprint 1 — Evidencia

Fecha: 2026-10-30. Entorno: contenedor Ubuntu 24.04, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16.15.

**Resumen:** la base de datos, el SDK de conectores, el conector del Banco Mundial y el worker están
implementados y probados contra PostgreSQL. La parte que necesita la API real sigue **bloqueada**:
la red del entorno corta todas las conexiones a los proveedores. Ningún dato real se ha cargado
todavía y ninguna fuente está aprobada.

## Pruebas ejecutadas

| Suite | Comando | Resultado |
| --- | --- | --- |
| Tipos | `pnpm typecheck` | Sin errores |
| Unitarias | `pnpm test:unit` | 29 de 29 superadas (SDK 21, Banco Mundial 8) |
| SQL | `pnpm db:test` | 35 de 35 aserciones superadas |
| Integración worker + PostgreSQL | `WITH_INTEGRATION=1 pnpm db:test` | 8 de 8 superadas |
| Control del runner | Aserción falsa deliberada | El runner falla con código 1, como debe |

### Qué demuestran

- **Esquema:** RLS activa en todas las tablas de `meta`, `ref`, `core` y `ops`; ninguna función
  ejecutable por `PUBLIC`; todas las funciones fijan `search_path`.
- **Lista blanca:** endpoints y pruebas de admisión con hosts no registrados se rechazan en la base;
  el cliente HTTP no envía la petición y no sigue redirecciones hacia otros hosts.
- **Admisión obligatoria:** sin una prueba anónima superada en 7 días no se abre ejecución; un 403
  se registra como `fail_auth_required` y no se abre ejecución.
- **Idempotencia:** repetir la misma carga da 0 nuevas, 0 modificadas y 0 revisiones.
- **Revisiones:** un valor cambiado genera 1 fila de historial con valor anterior, nuevo y ejecución.
- **Datos retirados:** se marcan con `withdrawn_at`, se conservan, desaparecen de la API pública y
  quedan en el historial; si vuelven, se restauran con su revisión.
- **Cuadre de métricas:** recibidas = nuevas + modificadas + iguales + rechazadas + sin valor.
- **Respuestas incompletas:** si el total declarado no cuadra con las filas recibidas, el indicador
  falla sin tocar sus datos y la ejecución queda `partial` con el error registrado.
- **Permisos:** `anon` no ve fuentes candidatas ni datasets privados, no escribe, no ejecuta la
  fusión ni ve errores, staging o equivalencias internas. `ingest_writer` no puede escribir
  observaciones directamente ni aprobar fuentes, y el worker opera realmente con ese rol.
- **Consulta:** `api.get_series` filtra por indicador, geografías y años, ordena y devuelve la
  licencia en cada fila.

### Datos de prueba

Las pruebas usan **datos sintéticos** (códigos `ZZA`, `ZZB`, `ZZZ` y valores inventados) dentro de
bases de prueba que se recrean en cada ejecución. La API del Banco Mundial se **simula** siguiendo su
documentación; su forma real queda pendiente de contrastar.

## Pruebas bloqueadas

| Prueba | Motivo |
| --- | --- |
| Admisión real de las 17 fuentes | `pnpm admission`: 35 de 35 peticiones con HTTP 000, `CONNECT tunnel failed, response 403` del proxy del entorno |
| Formato real de la API del Banco Mundial | Sin red; los esquemas Zod pueden necesitar ajustes |
| Carga real de los 12 indicadores | Sin red |
| 20 observaciones contrastadas con el proveedor | Sin red |
| Rendimiento de `get_series` con volumen real | Sin datos reales |
| Ejecución en GitHub Actions | La sesión no tiene permiso de escritura en el repositorio |

## Pendiente (Sprint 2)

- Proyecto Supabase dedicado, exposición del esquema `api` y despliegue de migraciones.
- Flujo programado de ingesta en GitHub Actions con secretos.
- Consulta Power Query paginada contra la API propia.

## Cómo reproducir

```bash
pnpm install
pnpm typecheck && pnpm test:unit
WITH_INTEGRATION=1 pnpm db:test
pnpm admission            # requiere red hacia los proveedores
```
