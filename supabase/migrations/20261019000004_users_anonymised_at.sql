-- SDD §16.6 step 3: account deletion "anonymises the visitors or users row as in 16.5".
-- visitors already has anonymised_at; users gets the same marker so a deleted
-- resident's row is recognisable and never signs in again (docs/DECISIONS.md DEC-015).

alter table haven.users add column anonymised_at timestamptz;
