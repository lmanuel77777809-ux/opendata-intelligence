# Puesta en marcha en Supabase

Pasos para el responsable del proyecto. Ninguna contraseña ni clave se escribe en el repositorio
ni en el chat: van en los secretos de GitHub.

## 1. Crear el proyecto

| Campo del formulario | Valor |
| --- | --- |
| Organization | La del responsable (plan gratuito) |
| GitHub (optional) | Sin conectar: el despliegue lo hace nuestro workflow, siempre a mano |
| Project name | `opendata-intelligence` |
| Database password | Frase larga: 5 palabras en minúsculas con guiones y un número. Solo letras, números y guiones |
| Region | East US (North Virginia): junto a GitHub Actions y con buena latencia para América |
| Enable Data API | Marcado |
| Automatically expose new tables | Desmarcado: lo que se publica lo deciden las migraciones |
| Enable automatic RLS | Marcado |

Plan gratuito: 500 MB (medido: unos 144 bytes por observación, unos 3 millones de observaciones)
y pausa tras una semana sin actividad (la ingesta diaria la evita).

## 2. Configuración en GitHub

En el repositorio: **Settings → Secrets and variables → Actions**. Hay dos vías; basta una.

### Vía automática (recomendada si no se quiere tocar el panel de Supabase)

1. En Supabase: **avatar → Account preferences → Access Tokens → Generate new token** (nombre
   `github-opendata`). Este token da control sobre todos los proyectos de la cuenta: guárdalo
   solo en GitHub y revócalo si deja de usarse.
2. Secretos en GitHub:

| Nombre | Valor |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | El token del paso 1 |
| `SUPABASE_DB_PASSWORD` | La contraseña con la que se creó el proyecto |
| `INGEST_WRITER_PASSWORD` | Otra frase distinta, para el rol `ingest_writer` |

Con eso, los workflows localizan el proyecto `opendata-intelligence`, obtienen el servidor del
pooler y la clave publicable, montan las conexiones y el despliegue **publica el esquema `api`**
en la Data API. Si hubiera varios proyectos con ese nombre, añade la variable
`SUPABASE_PROJECT_REF`.

### Vía manual

1. **Project Settings → Data API → Exposed schemas**: añade `api` y guarda.
2. Secretos y variable:

| Nombre | Tipo | Valor |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Secreto | Cadena de **Connect → Session pooler** (puerto 5432, usuario `postgres.<ref>`) con la contraseña en lugar de `[YOUR-PASSWORD]` |
| `INGEST_WRITER_PASSWORD` | Secreto | Otra frase distinta, para el rol `ingest_writer` |
| `SUPABASE_PUBLISHABLE_KEY` | Variable | **Project Settings → API Keys → Publishable key** (`sb_publishable_…`) |

En ambas vías, `scripts/supabase-config.mjs` deduce el resto y avisa de los errores típicos
(conexión directa solo IPv6, contraseña sin sustituir, puerto 6543, token inválido).
Variable opcional en las dos: `ODI_CONTACT`, correo de contacto para el User-Agent.

## 3. Desplegar

**Actions → Desplegar base de datos (Supabase) → Run workflow**. Aplica las migraciones
pendientes, habilita `ingest_writer` y comprueba que la API responde. El despliegue es siempre
manual: una migración nueva en `main` no llega a Supabase hasta que alguien lanza este workflow.

## 4. Cargar datos

**Actions → Ingesta programada → Run workflow** (con un dataset concreto o vacío para todos los
vencidos). Después se ejecuta cada día a las 05:17 UTC y cada dataset decide según su frecuencia.

## 5. Verificar producción

**Actions → Verificar producción (Supabase) → Run workflow**. Solo lectura: compara conteos y 20
valores al azar con la API del Banco Mundial y pasa el contrato REST contra la API publicada.

## 6. Aprobar y publicar una fuente

Los datos solo aparecen en la API cuando la fuente está aprobada y el dataset es público. Esa
decisión queda registrada como migración en el repositorio (quién, cuándo y con qué evidencia) y
en `meta.catalog_change`.

## Comprobaciones

- Los workflows publican sus resultados como anotaciones en la página de cada ejecución.
- Un HTTP 406 en la comprobación de la API indica que el esquema `api` no está expuesto.
