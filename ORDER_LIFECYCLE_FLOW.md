# Order Lifecycle Flow (USPS / UPS / Shipping Kit)

This document maps the order flow from submission to completion/cancellation, including customer actions, admin actions, and scheduled automations.

> Visual diagram version: [`ORDER_LIFECYCLE_FLOW.svg`](./ORDER_LIFECYCLE_FLOW.svg)

## Legend
- `->` next step
- `(Decision?)` branch point
- `[AUTO]` scheduled/automatic process
- `[ADMIN]` admin-triggered endpoint/process
- `[CUSTOMER]` customer-triggered endpoint/action

---

## 1) Order Created (3 entry options)

`Order Submitted` -> `(Shipping preference?)`

1. `Shipping Kit Requested` -> status: `shipping_kit_requested`
2. `Email Label Requested + UPS auto-label success` -> status: `label_generated`
3. `Email Label Requested + USPS auto-label success` -> status: `label_generated`
4. `Email Label Requested + label NOT generated` -> status: `order_pending`

---

## 2) Shipping Label Paths

### A) UPS / USPS email-label path

`order_pending` -> `[CUSTOMER/ADMIN] generate USPS label` -> `label_generated`

`order_pending` -> `[CUSTOMER/ADMIN] generate UPS label` -> `label_generated`

`label_generated` -> `[AUTO hourly] inbound tracking refresh` -> `(carrier says movement?)`
- yes -> `phone_on_the_way`
- delivered -> `delivered_to_us` (and `receivedAt` may be set automatically for email-label flow)
- no movement -> stay/reset at transit baseline (`label_generated`)

### B) Shipping kit path

`shipping_kit_requested` -> `[ADMIN] generate-label/:id` -> `needs_printing`

`needs_printing` -> `[ADMIN] status update` -> `kit_sent`

`kit_sent` -> `[ADMIN/AUTO] outbound tracking sync` -> `kit_on_the_way_to_customer`

`kit_on_the_way_to_customer` -> `[ADMIN/AUTO] outbound tracking sync` -> `kit_delivered`

`kit_delivered` -> customer ships device back -> inbound tracking updates -> `phone_on_the_way` -> `delivered_to_us`

---

## 3) After Device Received / QC Outcomes

`delivered_to_us` -> `(QC issue found?)`

### If NO QC issue
- `[ADMIN] status update` -> `completed`

### If YES QC issue
- `[ADMIN] send condition email (outstanding_balance/password_locked/stolen/fmi_active)`
  -> status often set to `emailed`
  -> `qcAwaitingResponse = true`

Then `(customer resolves issue?)`
- yes -> per-device issue state can move to `issue_resolved` / `processing` and QC continues
- no -> see 7-day unresolved auto-finalization below

---

## 4) Re-offer Flow (Price change after inspection)

From post-inspection state:

`[ADMIN] create re-offer` -> per-device status `re-offered-pending` + `autoAcceptDate = now + 7 days`

From `re-offered-pending`:
- `[CUSTOMER] accept-offer-action` -> `re-offered-accepted`
- `[CUSTOMER] return-phone-action` -> `re-offered-declined`
- `[AUTO daily] autoAcceptOffers when deadline passes` -> `re-offered-auto-accepted`

If customer declines re-offer:
- `[ADMIN] /orders/:id/return-label` -> `return-label-generated` (device return to customer flow)

---

## 5) Multi-device Order Roll-up

When all device statuses are terminal, order-level status can be derived:

- any device declined/return-ish -> order `re-offered-declined`
- any device accepted/auto-accepted -> order `re-offered-accepted`
- all devices `completed`/`paid` -> order `completed`

---

## 6) Cancellation & Void Branches

### Manual cancellation

Eligible only when:
- email-label order, or
- shipping-kit order at `kit_delivered`

Flow:
`[ADMIN] /orders/:id/cancel` -> optional label void attempt -> `cancelled`

### Automatic 28-day unused-label void

`label_generated` + label age >= 28 days + still voidable
-> `[AUTO hourly] autoVoidExpiredLabels`
-> void label(s)
-> `cancelled` with reason `label_voided_no_response_28_days`

### Additional dormant auto-cancel framework

A 15-day dormant auto-cancel sweep exists in code, but global feature flag is currently disabled.

---

## 7) 7-Day Rules (Important)

There are TWO different 7-day automations:

1. **Re-offer auto-accept**
   - `re-offered-pending` + deadline reached -> `re-offered-auto-accepted`

2. **Unresolved QC auto-finalization**
   - status `emailed` + `qcAwaitingResponse = true` + no response for 7 days
   -> `[AUTO hourly] autoFinalizeUnresolvedPayouts`
   -> order forced to `completed`
   -> payout reduced to 25% of base (75% reduction)

---

## 8) Admin Override Path (Can happen almost anytime)

`[ADMIN] PUT /orders/:id/status` can explicitly set status (e.g., `received`, `completed`, etc.), which can bypass normal automatic progression.

---

## 9) Condensed Arrow Map

```text
Order Submitted
  -> Shipping Kit Requested -> shipping_kit_requested -> needs_printing -> kit_sent -> kit_on_the_way_to_customer -> kit_delivered -> phone_on_the_way -> delivered_to_us
  -> Email Label Requested (UPS) -> label_generated -> phone_on_the_way -> delivered_to_us
  -> Email Label Requested (USPS) -> label_generated -> phone_on_the_way -> delivered_to_us
  -> Email Label Requested (no label) -> order_pending -> generate label (UPS/USPS) -> label_generated -> phone_on_the_way -> delivered_to_us

From delivered_to_us
  -> No issue -> completed
  -> QC issue -> emailed
       -> customer resolves -> issue_resolved/processing -> continue QC -> completed
       -> unresolved 7 days -> completed (auto reduced payout)

From post-inspection when re-offer needed
  -> re-offered-pending
       -> customer accepts -> re-offered-accepted
       -> customer declines -> re-offered-declined -> return-label-generated
       -> no response 7 days -> re-offered-auto-accepted

At label_generated
  -> no shipment for 28 days -> auto void labels -> cancelled

Manual cancel (eligible statuses/path)
  -> cancelled
```
