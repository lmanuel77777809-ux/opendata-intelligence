# Puesta en marcha en Supabase

Pasos para el responsable del proyecto. Ninguna clave se escribe en el repositorio ni en el chat.

## 1. Crear el proyecto

1. En [supabase.com](https://supabase.com), **New project**, dedicado a OpenData Intelligence.
2. Región en la Unión Europea; plan gratuito para empezar (500 MB de base de datos; el proyecto
   se pausa tras una semana sin actividad).
3. Guarda la contraseña de la base de datos en un gestor de contraseñas.

## 2. Exponer el esquema `api`

**Project Settings → Data API → Exposed schemas**: añade `api`. Es el único esquema que necesita
la plataforma; el resto de esquemas propios no deben exponerse.

## 3. Secretos y variables de GitHub

En el repositorio: **Settings → Secrets and variables → Actions**.

| Nombre | Tipo | Valor |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Secreto | Cadena del **pooler en modo sesión** (puerto 5432), usuario `postgres.<ref>`. Está en *Connect → Session pooler*. GitHub Actions no tiene IPv6, por eso no sirve la conexión directa |
| `INGEST_WRITER_PASSWORD` | Secreto | Contraseña larga y aleatoria para el rol `ingest_writer` |
| `INGEST_DATABASE_URL` | Secreto | La misma cadena del pooler con usuario `ingest_writer.<ref>` y la contraseña anterior |
| `SUPABASE_URL` | Variable | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Variable | Clave publicable (no es secreta: la usan Excel y la web) |
| `ODI_CONTACT` | Variable | Opcional: correo de contacto para el User-Agent |

## 4. Desplegar

**Actions → Desplegar base de datos (Supabase) → Run workflow**. Aplica las migraciones
pendientes, habilita `ingest_writer` y comprueba que la API responde. Las migraciones nuevas se
despliegan solas al llegar a `main`.

## 5. Cargar datos

**Actions → Ingesta programada → Run workflow** (con un dataset concreto o vacío para todos los
vencidos). Después se ejecuta cada día a las 05:17 UTC y cada dataset decide según su frecuencia.

## 6. Aprobar y publicar una fuente

Los datos solo aparecen en la API cuando la fuente está aprobada y el dataset es público. Esa
decisión queda registrada como migración en el repositorio (quién, cuándo y con qué evidencia).

## Comprobaciones

- El workflow de despliegue publica como anotaciones las migraciones aplicadas, el estado de las
  fuentes y el número de observaciones.
- Un HTTP 406 en la comprobación de la API indica que falta el paso 2.
