## 2026-10-07 - Quarantine reasons match what reconciliation writes (#9689 follow-up)

`invalid_generation_timestamps` is removed from the quarantine reasons: since the #9689 review, a finished run whose timestamps cannot be attributed is released, never quarantined, so nothing writes that reason. The unreadable-ledger quarantine test now also checks that `reservation.quarantined.json` keeps the reservation exactly as it was before release.

