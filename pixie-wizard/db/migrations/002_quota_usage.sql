create table if not exists wizard_entitlements (
  program_id text not null references hosted_programs(id) on delete cascade,
  workspace_id text not null,
  plan text not null check (plan in ('starter', 'growth', 'scale')),
  status text not null default 'active' check (status in ('active', 'past_due', 'suspended')),
  included_cents integer not null check (included_cents >= 0),
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (program_id, effective_from),
  check (effective_until is null or effective_until > effective_from)
);

create index if not exists wizard_entitlements_program_effective_idx
  on wizard_entitlements (program_id, effective_from desc);
