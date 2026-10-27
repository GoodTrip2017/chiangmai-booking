# Booking management release runbook

This branch changes a live reservation database. Railway deploys `main` automatically; keep the pull request in draft until each gate below is evidenced. Do not use production customer records as test fixtures.

## Before merging

1. Confirm the latest PR commit passed `Verify booking service`: PostgreSQL 18 migration and integration/security suites, unit tests, dependency audit, production Docker build, and image vulnerability scan. Record the commit SHA and run URL.
2. In Railway, confirm the production PostgreSQL service has a recent completed backup. Perform a restore into an isolated database and verify that the restored booking count and a sample of IDs match production. A backup entry without a restore check is not enough.
3. Record read-only production baselines: total booking count, count by current status, earliest and latest visit dates, count of non-null `line_user_id`, and a few known booking IDs. Never export customer contact data into the repository or CI logs.
4. Confirm `ADMIN_PASSWORD_HASH`, `DATABASE_URL`, Resend settings, LINE channel settings, `LINE_GROUP_ID`, and `APP_ORIGIN` exist in Railway without copying their values into tickets or logs. Check that the bot group and sender domain are still the intended ones.
5. Review mobile booking and admin layouts at narrow and wide widths, including bilingual validation, empty states, 13-person guidance, source dropdown, and staff role restrictions.

## Deployment

1. Merge only after the restore check and final review. Railway will build and start the new image; startup runs the additive, idempotent schema migration.
2. Watch the deployment and application logs for migration errors. The migration must not delete bookings or overwrite old visit/contact fields. Stop traffic to the new deployment if startup fails.
3. Compare post-migration booking counts, legacy IDs, visit dates, statuses, and `line_user_id` count against the baselines. The isolated CI migration test confirms the code path, but does not replace this production comparison.
4. With a staff account, inspect a real existing booking read-only. Verify that old source and attendance values appear as unknown where absent. Check that the 12-person overlapping-slot rule, 90-minute service, 14:00 start, Tuesday closure, and Bangkok time render correctly.
5. Use a controlled test booking only after the database and login checks pass. Mark it as a test in notes, then verify auto-confirmation, Resend acceptance, LINE staff-group API acceptance, reporting, and cancellation history. Do not infer actual email delivery or LINE read status from API acceptance.

## If validation fails

- Keep the pre-deployment backup available. Revert the application to the previous known-good image or commit to restore the prior booking interface. The migration only adds columns/tables and preserves legacy booking fields, so application rollback should not require destructive schema rollback.
- If the data itself is damaged, pause writes and restore the isolated-verified production backup through Railway's recovery procedure, then reconcile reservations created after that backup. This step affects live customer data and requires explicit operational approval.
- Record the failing commit, deployment time, symptoms, affected booking IDs, and any customer-facing communication separately from credentials.

## Reporting limits after release

Historical missing discovery, check-in, notification, and capacity records stay unknown. Customer identity is based on normalized email, not name. Prior recorded visit is not proof of a customer's true first visit. LINE sends only to the configured staff group; it does not DM customers. Anonymous funnel, revenue, and complete historical capacity utilization are withheld until reliable source data exists.
