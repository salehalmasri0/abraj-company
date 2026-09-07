# Abraj HR Portal — Supabase

Project URL: `https://pnydgfxcbwvmltrnkcnw.supabase.co`

## Production architecture

- Browser: `employee-portal.html` + Supabase publishable key only.
- Authentication: Supabase Auth SMS OTP.
- Database: Supabase PostgreSQL.
- Authorization: PostgreSQL Row Level Security (RLS).
- Server-only operations: Edge Functions with `SUPABASE_SECRET_KEY`.
- Employee API operations are implemented through Supabase Edge Functions.

## Database

Apply `supabase/migrations/20260907000000_initial_hr.sql` in the Supabase SQL Editor or deploy it with the Supabase CLI.

The migration creates:

- `employees`
- `profiles`
- `salaries`
- `attendance`
- role helpers and RLS policies
- automatic profile creation for new Auth users

No employee data belongs in GitHub.

## Auth / SMS

Enable Authentication → Providers → Phone in Supabase and configure the project's supported SMS provider.

The portal uses Supabase SMS OTP. National-ID-to-phone resolution is performed only inside the Edge Functions, so the browser never receives the full phone number.

## Edge Functions

Deploy:

```bash
supabase functions deploy request-employee-otp
supabase functions deploy verify-employee-otp
```

The functions require a server-only secret named `SUPABASE_SECRET_KEY` containing the current `sb_secret_...` key. Set it through Supabase secrets/CLI. Never commit it to GitHub or place it in HTML/JavaScript.

`supabase/config.toml` intentionally disables platform JWT verification for the two public OTP endpoints because they are pre-authentication endpoints. They validate their input themselves and keep the secret entirely server-side.

## Employee data

Each active employee should have:

- `national_id`
- `full_name`
- `phone` in E.164 format, e.g. `+9627XXXXXXXX`
- `employee_number`
- `department`
- `job_title`
- `status = 'active'`

Salary data goes into `public.salaries`; attendance goes into `public.attendance`.

## First Admin

Create the first Auth user from the Supabase Dashboard using the administrator's phone number. Then, after confirming the correct UUIDs, run once:

```sql
update public.profiles
set role = 'admin', employee_id = 'EMPLOYEE_UUID'
where id = 'AUTH_USER_UUID';

update public.employees
set user_id = 'AUTH_USER_UUID'
where id = 'EMPLOYEE_UUID';
```

This avoids an insecure public "first user becomes admin" rule.

## Security model

- Publishable key is safe for the browser when RLS is correctly configured.
- Secret key is backend-only and bypasses RLS.
- Anonymous access to HR tables is revoked.
- Employees read only their own profile, salary and attendance.
- HR/Admin manage HR records.
- Supervisors read employees and attendance in their own department.
- The employee portal has `noindex,nofollow,noarchive`.
