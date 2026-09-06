-- Abraj Company — initial Supabase HR schema
-- Apply this migration to a new Supabase project.

create extension if not exists pgcrypto;

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  employee_number text unique,
  national_id text unique,
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
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select employee_id from public.profiles where id = auth.uid();
$$;

alter table public.employees enable row level security;
alter table public.profiles enable row level security;
alter table public.salaries enable row level security;
alter table public.attendance enable row level security;

-- Profiles: a user can read their own profile; admins/HR can manage profiles.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_role() in ('admin','hr'));

drop policy if exists profiles_manage_admin_hr on public.profiles;
create policy profiles_manage_admin_hr on public.profiles
  for all to authenticated
  using (public.current_user_role() in ('admin','hr'))
  with check (public.current_user_role() in ('admin','hr'));

-- Employees: employees see their own record; admin/HR see all; supervisors see their department.
drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.current_user_role() in ('admin','hr')
    or (public.current_user_role() = 'supervisor' and department = (select department from public.employees where user_id = auth.uid()))
  );

drop policy if exists employees_manage_admin_hr on public.employees;
create policy employees_manage_admin_hr on public.employees
  for all to authenticated
  using (public.current_user_role() in ('admin','hr'))
  with check (public.current_user_role() in ('admin','hr'));

-- Salaries: employees see their own salary; admin/HR see all.
drop policy if exists salaries_select on public.salaries;
create policy salaries_select on public.salaries
  for select to authenticated
  using (employee_id = public.current_employee_id() or public.current_user_role() in ('admin','hr'));

drop policy if exists salaries_manage_admin_hr on public.salaries;
create policy salaries_manage_admin_hr on public.salaries
  for all to authenticated
  using (public.current_user_role() in ('admin','hr'))
  with check (public.current_user_role() in ('admin','hr'));

-- Attendance: employees see their own attendance; supervisors see their department; admin/HR see all.
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated
  using (
    employee_id = public.current_employee_id()
    or public.current_user_role() in ('admin','hr')
    or (
      public.current_user_role() = 'supervisor'
      and exists (
        select 1
        from public.employees e1
        join public.employees e2 on e2.id = attendance.employee_id
        where e1.user_id = auth.uid() and e1.department = e2.department
      )
    )
  );

drop policy if exists attendance_manage_admin_hr on public.attendance;
create policy attendance_manage_admin_hr on public.attendance
  for all to authenticated
  using (public.current_user_role() in ('admin','hr'))
  with check (public.current_user_role() in ('admin','hr'));

-- New Auth users receive a profile row. Employee assignment is done by admin/HR.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Keep updated_at current.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at before update on public.employees
for each row execute procedure public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute procedure public.set_updated_at();
