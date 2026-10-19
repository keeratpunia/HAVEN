-- SDD §16.3: "guests and residents see a short notice before giving data ... Store
-- consent_version and consent_at." visitors already has the two columns (§11.2);
-- residents had none, so R-03's consent checkbox was never recorded
-- (FINAL-QA-REPORT D-05, docs/DECISIONS.md DEC-020).

alter table haven.residents add column consent_version text;
alter table haven.residents add column consent_at timestamptz;
