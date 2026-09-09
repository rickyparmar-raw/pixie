create table if not exists wizard_people (
  hca_id text primary key,
  email text not null,
  display_name text not null,
  slack_user_id text,
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  added_by_hca_id text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wizard_people_email_idx on wizard_people (lower(email));
create unique index if not exists wizard_people_slack_idx on wizard_people (slack_user_id) where slack_user_id is not null;

create table if not exists wizard_global_access (
  hca_id text primary key references wizard_people(hca_id) on delete cascade,
  role text not null check (role in ('superadmin')),
  granted_by_hca_id text,
  granted_at timestamptz not null default now()
);
