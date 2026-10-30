-- Decisión: aprobar y publicar el Banco Mundial (World Bank Indicators API v2).
-- Aprobado por el responsable del proyecto el 2026-10-30.
-- Evidencia:
--   - Admisión real: 5 endpoints con HTTP 200 JSON sin credenciales (docs/sprint-1-evidencia.md).
--   - Carga real verificada: 163.525 observaciones; 12 de 12 indicadores cuadran con la API y
--     20 de 20 valores al azar coinciden; la repetición no cambia nada.
--   - Licencia: CC BY 4.0 (licencia por defecto de los datos del Banco Mundial). Obliga a citar la
--     fuente: la API devuelve license_code en cada observación.
--   - Restricción: solo se ingiere la base 2 (World Development Indicators).

set local odi.change_reason = 'Publicación aprobada el 2026-10-30; evidencia en docs/sprint-1-evidencia.md';

update meta.source
set status = 'approved',
    status_reason = 'Aprobada el 2026-10-30: admisión anónima HTTP 200, carga real verificada (163.525 observaciones) y licencia CC BY 4.0 revisada',
    restrictions = 'Atribución obligatoria (CC BY 4.0). Solo la base 2, World Development Indicators',
    terms_reviewed_at = date '2026-10-30',
    updated_at = now()
where code = 'worldbank';

update meta.dataset
set is_public = true, updated_at = now()
where code in ('worldbank:wdi-economy', 'worldbank:wdi-demography');
