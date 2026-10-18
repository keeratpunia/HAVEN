-- SDD §16.5 "Guest identity: 365 days after last visit with no future visits:
-- full_name → 'Former guest', phone → null, anonymised_at set" (and §16.6 account
-- deletion, which anonymises the same way). The init check required every visitor to
-- keep a phone unless a host created them, so anonymising any self-registered guest
-- violated it and aborted the whole retention run. An anonymised row may now have
-- neither (docs/DECISIONS.md DEC-015).

alter table haven.visitors drop constraint visitors_check;
alter table haven.visitors add constraint visitors_check
  check (phone is not null or created_by_host_id is not null or anonymised_at is not null);
