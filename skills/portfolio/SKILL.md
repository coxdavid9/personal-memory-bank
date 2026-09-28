# Portfolio skill

## Description
Read and record David's personal portfolio data and validated snapshots.

## Default risk
safe for reads; monitor for snapshot/holding writes.

## Reads
Portfolio holdings, quotes, allocation, snapshot history.

## Writes
Manual holding records and daily snapshots.

## Rules
- Never give buy/sell recommendations.
- Never represent unavailable quotes as $0.
- Preserve the distinction between current value, stale value, and incomplete value.
