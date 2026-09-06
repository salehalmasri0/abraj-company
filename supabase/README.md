# Supabase Backend — Abraj Company

This directory contains the database migrations and Supabase project configuration for the Abraj Company employee portal.

## Security

- The browser may use only the Supabase **publishable** key.
- The Supabase **secret** key must remain server-side and must never be committed to GitHub.
- Row Level Security (RLS) is required on every application table before production use.
- Do not commit `.env` files or employee data.

## Initial architecture

- Supabase Auth: user accounts and sessions
- PostgreSQL: employees, salaries, attendance, and profiles
- RLS: role-based access control
- Storage: employee documents (to be added in a later migration)

## Roles

- `admin`
- `hr`
- `supervisor`
- `employee`

The existing `employee-portal.html` is preserved. Integration with Supabase will be added after the project URL is available and the database migration has been applied.
