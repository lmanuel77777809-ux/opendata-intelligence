-- Emula lo mínimo de Supabase que necesitan las migraciones: sus roles de API.
-- Solo para pruebas locales y CI; en Supabase estos roles ya existen.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Rol con el que PostgREST se conecta y desde el que asume anon/authenticated (como en Supabase).
-- La contraseña solo vale para la base de pruebas.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator_test';
  end if;
end
$$;
grant anon, authenticated to authenticator;
