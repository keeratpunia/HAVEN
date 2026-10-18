-- docs/DECISIONS.md DEC-016 item 4: an SMS row's recipient phone must not be kept
-- indefinitely. The init check required recipient_phone on every 'phone' row forever;
-- it now applies only while the SMS can still be sent (queued or sending), so the
-- retention job can null the phone on rows past the §16.5 notifications period.

alter table haven.notifications drop constraint notifications_check;
alter table haven.notifications add constraint notifications_check
  check (recipient_type <> 'phone' or recipient_phone is not null
         or status in ('sent', 'failed', 'cancelled'));
