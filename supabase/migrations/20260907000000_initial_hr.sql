-- Abraj Company HR Portal — production Supabase schema
-- Supabase Auth + RLS. No secret/service key belongs in the browser.

create extension if not exists pgcrypto;

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  employee_number text unique,
  national_id text unique not null,
  full_name text not null,
  phone text,
  email text,
  department text,
  job_title text,
  status text not null default 'active' check (status in ('active','inactive','on_leave','terminated')),
  hire_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_id uuid unique references public.employees(id) on delete set null,
  role text not null default 'employee' check (role in ('admin','hr','supervisor','employee')),
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.salaries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  salary_month date not null,
  basic_salary numeric(12,2) not null default 0,
  allowances numeric(12,2) not null default 0,
  deductions numeric(12,2) not null default 0,
  net_salary numeric(12,2) generated always as (basic_salary + allowances - deductions) stored,
  pdf_path text,
  created_at timestamptz not null default now(),
  unique(employee_id, salary_month)
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  check_in timestamptz,
  check_out timestamptz,
  status text not null default 'present' check (status in ('present','absent','late','leave','holiday','off')),
  notes text,
  created_at timestamptz not null default now(),
  unique(employee_id, work_date)
);

create index if not exists idx_employees_department on public.employees(department);
create index if not exists idx_salaries_employee_month on public.salaries(employee_id, salary_month desc);
create index if not exists idx_attendance_employee_date on public.attendance(employee_id, work_date desc);

create or replace function public.current_user_role()
returns text language sql stable security definer set search_path=public
as $$ select role from public.profiles where id=auth.uid(); $$;

create or replace function public.current_employee_id()
returns uuid language sql stable security definer set search_path=public
as $$ select employee_id from public.profiles where id=auth.uid(); $$;

create or replace function public.current_user_department()
returns text language sql stable security definer set search_path=public
as $$ select e.department from public.employees e join public.profiles p on p.employee_id=e.id where p.id=auth.uid(); $$;

alter table public.employees enable row level security;
alter table public.profiles enable row level security;
alter table public.salaries enable row level security;
alter table public.attendance enable row level security;

-- Remove previous policies so this migration is safely re-runnable.
drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_manage_admin_hr on public.profiles;
drop policy if exists employees_select on public.employees;
drop policy if exists employees_manage_admin_hr on public.employees;
drop policy if exists salaries_select on public.salaries;
drop policy if exists salaries_manage_admin_hr on public.salaries;
drop policy if exists attendance_select on public.attendance;
drop policy if exists attendance_manage_admin_hr on public.attendance;

create policy profiles_select_self on public.profiles for select to authenticated
using (id=auth.uid() or public.current_user_role() in ('admin','hr'));
create policy profiles_manage_admin_hr on public.profiles for all to authenticated
using (public.current_user_role() in ('admin','hr'))
with check (public.current_user_role() in ('admin','hr'));

create policy employees_select on public.employees for select to authenticated
using (
  user_id=auth.uid()
  or public.current_user_role() in ('admin','hr')
  or (public.current_user_role()='supervisor' and department=public.current_user_department())
);
create policy employees_manage_admin_hr on public.employees for all to authenticated
using (public.current_user_role() in ('admin','hr'))
with check (public.current_user_role() in ('admin','hr'));

create policy salaries_select on public.salaries for select to authenticated
using (employee_id=public.current_employee_id() or public.current_user_role() in ('admin','hr'));
create policy salaries_manage_admin_hr on public.salaries for all to authenticated
using (public.current_user_role() in ('admin','hr'))
with check (public.current_user_role() in ('admin','hr'));

create policy attendance_select on public.attendance for select to authenticated
using (
  employee_id=public.current_employee_id()
  or public.current_user_role() in ('admin','hr')
  or (public.current_user_role()='supervisor' and exists (
    select 1 from public.employees e where e.id=attendance.employee_id and e.department=public.current_user_department()
  ))
);
create policy attendance_manage_admin_hr on public.attendance for all to authenticated
using (public.current_user_role() in ('admin','hr'))
with check (public.current_user_role() in ('admin','hr'));

-- Least-privilege Data API grants. No anonymous access to HR tables.
revoke all on public.employees from anon;
revoke all on public.profiles from anon;
revoke all on public.salaries from anon;
revoke all on public.attendance from anon;
grant select on public.employees, public.profiles, public.salaries, public.attendance to authenticated;
grant insert, update, delete on public.employees, public.profiles, public.salaries, public.attendance to authenticated;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_user_department() to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.phone, new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger language plpgsql
as $$ begin new.updated_at=now(); return new; end; $$;

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at before update on public.employees for each row execute procedure public.set_updated_at();
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();

-- Prevent employees from being linked to another employee by ordinary client updates.
-- Admin/HR retain management through the policies above.
