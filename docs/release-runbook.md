# Booking management release runbook

This branch changes a live reservation database. Railway deploys `main` automatically; keep the pull request in draft until each gate below is evidenced. Do not use production customer records as test fixtures.

Observed in Railway on 2026-10-28: production Postgres has daily, weekly, and monthly volume backups; the newest listed daily snapshot was about 15 hours old. Point-in-time recovery was off. An on-demand backup attempt returned `Plan limit of 10 backups per volume exceeded`; no backup was created and no existing backup was deleted. These observations do not establish that any snapshot can be restored successfully.

Logical restore drill on 2026-10-28 (Asia/Taipei): Railway CLI confirmed the booking service is in `brilliant-nourishment / production` and its `DATABASE_URL` points to `postgres.railway.internal/railway`. A temporary account SSH key connected to that Postgres service. A read-only baseline found 0 bookings, 1 admin session, 1 LINE group candidate, 5 admin login-limit rows, and 7 request-limit rows across 5 tables. `pg_dump -Fc` of database `railway` and `pg_restore --exit-on-error` into a separate `chiangmai_booking_drill_20261028` database succeeded; the restored table names and all five row counts matched. The scratch database and dump file were removed and absence verified. The temporary SSH key was revoked in Railway and its local keypair removed. This verifies a logical export/restore at that moment; it does **not** test restoring a Railway volume snapshot, nor can it compare sample booking IDs while the production bookings table is empty. Latest PR SHA `94b3e5868bb2645db36ffb14caf64c14d8762644` passed [Verify booking service](https://github.com/GoodTrip2017/chiangmai-booking/actions/runs/40538011472).

## Before merging

1. Confirm the latest PR commit passed `Verify booking service`: PostgreSQL 18 migration and integration/security suites, unit tests, dependency audit, production Docker build, and image vulnerability scan. Record the commit SHA and run URL.
2. In Railway, confirm the production PostgreSQL service has recent completed volume backups. These snapshots restore only into the same project and environment, so **do not** click Restore on production merely to run a drill. Use a separate logical `pg_dump` and `pg_restore` into an isolated scratch database; compare the restored booking count and a sample of IDs. A listed snapshot without a restore drill is not verified.
3. Record read-only production baselines: total booking count, count by current status, earliest and latest visit dates, count of non-null `line_user_id`, and a few known booking IDs. Never export customer contact data into the repository or CI logs.
4. Confirm `ADMIN_PASSWORD_HASH`, `DATABASE_URL`, Resend settings, LINE channel settings, `LINE_GROUP_ID`, and `APP_ORIGIN` exist in Railway without copying their values into tickets or logs. Check that the bot group and sender domain are still the intended ones.
5. Review mobile booking and admin layouts at narrow and wide widths, including bilingual validation, empty states, 13-person guidance, source dropdown, and staff role restrictions.

## Deployment

1. Merge only after the logical restore drill and final review. Railway will build and start the new image; startup runs the additive, idempotent schema migration. If the last volume snapshot is too old and an on-demand backup is blocked by the plan's backup-count limit, wait for the next successful scheduled backup or resolve retention deliberately before deploying.
2. Watch the deployment and application logs for migration errors. The migration must not delete bookings or overwrite old visit/contact fields. Stop traffic to the new deployment if startup fails.
3. Compare post-migration booking counts, legacy IDs, visit dates, statuses, and `line_user_id` count against the baselines. The isolated CI migration test confirms the code path, but does not replace this production comparison.
4. With a staff account, inspect a real existing booking read-only. Verify that old source and attendance values appear as unknown where absent. Check that the 12-person overlapping-slot rule, 90-minute service, 14:00 start, Tuesday closure, and Bangkok time render correctly.
5. Use a controlled test booking only after the database and login checks pass. Mark it as a test in notes, then verify auto-confirmation, Resend acceptance, LINE staff-group API acceptance, reporting, and cancellation history. Do not infer actual email delivery or LINE read status from API acceptance.

## If validation fails

- Keep the pre-deployment backup available. Revert the application to the previous known-good image or commit to restore the prior booking interface. The migration only adds columns/tables and preserves legacy booking fields, so application rollback should not require destructive schema rollback.
- If the data itself is damaged, pause writes. Railway's volume restore stages a swap of the production volume in the same project and environment; review it before deployment, then reconcile reservations created after the snapshot. A separately tested logical dump can also be restored into a scratch database first. Any production data replacement requires explicit operational approval.
- Record the failing commit, deployment time, symptoms, affected booking IDs, and any customer-facing communication separately from credentials.

## Reporting limits after release

Historical missing discovery, check-in, notification, and capacity records stay unknown. Customer identity is based on normalized email, not name. Prior recorded visit is not proof of a customer's true first visit. LINE sends only to the configured staff group; it does not DM customers. Anonymous funnel, revenue, and complete historical capacity utilization are withheld until reliable source data exists.
