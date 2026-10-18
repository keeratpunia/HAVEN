-- SDD §9.4 "reject PHOTO_REUSED if the same hash exists for this visitor", made a
-- database guarantee: the API's check-then-insert let two parallel uploads of the same
-- photo both through (docs/SECURITY-AUDIT.md SA-17). One live photo per hash per
-- visitor; deleted photos (retention, account deletion) don't count.

drop index if exists haven.media_sha_visitor_idx;
create unique index media_sha_visitor_uq on haven.media (owner_visitor_id, sha256)
  where owner_visitor_id is not null and deleted_at is null;
