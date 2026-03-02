# Repricer Box: End-to-end steps, algorithms, deductions, percentages, and XML/CSV dependencies

This document explains exactly what `repricer-process/run-repricer.js` does and which fields it uses from CSV and XML.

## 1) Inputs and configuration

The repricer script reads:

- Local CSV input: `amz.csv` (default folder `/shc33/feed`).
- Local template XML: `feed.xml` (same folder).
- Remote SellCell competitor XML feed: `http://feed.sellcell.com/secondhandcell/feed.xml` (Basic Auth).

The script validates that the CSV and template XML files exist before processing.

## 2) Required CSV columns

`amz.csv` must contain these columns:

- `name`
- `storage`
- `lock_status`
- `condition`
- `price`
- `amz`

If any are missing, execution fails.

## 3) Repricer rules (profit target + bump tiers)

Default rules:

- Target profit percent: `15%` (`targetProfitPct = 0.15`)
- Bump tiers:
  - `>= 75%` profit → `+$5`
  - `>= 45%` profit → `+$3`
  - `>= 15%` profit → `+$1`

Rules can come from Firestore (`config/repricerRules`) unless overridden via CLI flags.

## 4) Normalization pipeline before matching

To make CSV rows and XML devices line up, the script normalizes:

- **Model names** (uppercasing, removing Samsung prefix, alias mapping, removing trailing `5G`).
- **Conditions**:
  - `damaged` / `faulty` / `broken` → `broken`
  - `poor` → `fair`
  - `like_new` variants → `flawless`
- **Carriers**:
  - Handles `att`, `at&t`, `tmobile`, `t-mobile`, `unlocked`, etc.

## 5) How SellCell XML is converted into a feed index

From each SellCell `<device>` node, the script uses:

- `device_name`
- `capacity`
- `network`
- condition sections:
  - `prices_likenew`
  - `prices_good`
  - `prices_poor`
  - `prices_faulty`

For each condition section, it reads all `<price>` entries and:

1. Ignores merchant `secondhandcell`.
2. Parses `merchant_price` from remaining merchants.
3. Takes the **highest competitor price** for that condition.
4. Stores that value in a key bucket:
   - Key base: `MODEL|STORAGE`
   - Carrier bucket when recognized (`att`, `verizon`, `tmobile`, `unlocked`)
   - Also updates an `any` fallback bucket.

So each row effectively matches against the top competitor offer by model/storage/condition (carrier-specific when possible).

## 6) Repricing algorithm (deductions + percentages)

For each CSV row:

1. Find matching competitor feed price (`original_feed_price`) by normalized model/storage/condition and carrier (or `any` fallback).
2. Parse Amazon value from `amz`.
3. If either Amazon or competitor price is missing/invalid, mark row as warning and skip repricing.

When both prices are valid, the walkaway model is:

- `after_amazon = amz * 0.92 - 10`
  - (8% deduction + fixed `$10` deduction)
- `sellcell_fee = min(after_amazon * 0.08, 30)`
  - (8% capped at `$30`)
- `after_sellcell = after_amazon - sellcell_fee`
- `shipping_fee = 15`
- `condition_fee`:
  - `flawless` / `good` = `10`
  - `fair` = `30`
  - `broken` = `50`
- `total_walkaway = after_sellcell - shipping_fee - condition_fee`

Profit math against competitor reference price:

- `profit = total_walkaway - original_feed_price`
- `profit_pct = profit / original_feed_price`

Decision logic:

- If `profit_pct >= targetProfitPct` (default 15%):
  - `new_price = original_feed_price + bumpAmount` (tier bump from table)
- Else:
  - `new_price = total_walkaway / (1 + targetProfitPct)`

Final rounding:

- cents `< .50` → round down to whole dollar
- cents `= .50` → keep `.5`
- cents `> .50` → round up to whole dollar

Output metrics include `new_profit` and `new_profit_pct`.

## 7) How XML gets updated

The script builds a map of repriced rows keyed by:

- `sellcellModelName|storage|carrier|condition`

Then it traverses template `feed.xml` models/prices and updates matching nodes under:

- carriers: `att`, `verizon`, `tmobile`, `unlocked`
- conditions: `flawless`, `good`, `fair`, `broken`

It writes the updated XML back to `feed.xml` and reports:

- number of matched keys
- number of changed price nodes
- number of models touched
- number of normalized deeplinks

## 8) Optional CSV output and Firestore import

- If `--write-csv` is enabled, writes `repricer-output.csv` with calculation columns.
- Always imports updated XML pricing into Firestore `devices/{brand}/models/{slug}` and records price history for changed docs.

## 9) CLI controls that affect behavior

Important flags:

- `--dir <path>`: choose folder for `amz.csv` and `feed.xml`.
- `--bump <number>`: override tier behavior with a single bump tier.
- `--default-rules`: ignore Firestore rules and use defaults.
- `--write-csv`: emit `repricer-output.csv`.
- `--no-gca`: disable automatic `gca` command at the end.
- `--project-id <id>`: set Firebase project ID explicitly.
