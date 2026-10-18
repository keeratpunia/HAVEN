-- SDD §9.7: "A job fetches receipts 15 min later". Marks a sent push whose Expo receipts
-- were fetched, so each push is checked once.

alter table haven.notifications add column receipt_checked_at timestamptz;
create index notifications_receipts_due_idx on haven.notifications (sent_at)
  where channel = 'push' and status = 'sent' and receipt_checked_at is null;
