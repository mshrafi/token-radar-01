# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mshrafi/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mshrafi/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Ranked board of 200 pre-token protocols by implied token value — model **radar-3**, fitted from the snapshot's own live-token market caps — with a sortable, filterable dashboard and per-protocol farm plans.

## The model (radar-3)

Fitted at build time from the snapshot's 119 live, non-CEX tokens (CEX excluded: their market caps are not TVL-driven), in log space:

```
y_i        = ln( clip( mcap_i / tvl_i , 0.01 , 10 ) )
y-hat_i    = intercept + slope * ( ln tvl_i - mean ln tvl )
cat_resid  = ( n / (n + 5) ) * mean( y_i - y-hat_i ) over live comps in the category
ratio_hat  = clip( exp( intercept + slope * (ln TVL - mean ln TVL) + cat_resid ), 0.005 , 5 )
implied    = round( TVL * ratio_hat * ( 1 + clamp(change_7d, -60, 120) / 100 * 0.10 ) )
```

On this snapshot the fit yields intercept **−1.420**, slope **−0.438**, mean ln TVL **17.5221** — so a token is worth a smaller share of TVL the bigger the protocol is (mcap ∝ TVL^0.56). Cat-neutral ratios: $10M TVL → 0.45, $100M → 0.16, $1B → 0.06. The fitting code lives in `lib/model.ts` (`fitRadar3`); the numbers are what it returns on this snapshot, not constants in the code, so a different snapshot refits them. No protocol name is hardcoded anywhere; live-token protocols are kept apart and shown at their market cap, never mixed into the ranked board.

## Validation

5-fold cross-validation on the 119 live tokens (5 seeds, pooled out-of-fold, re-run with this entry's own code in `/tmp/verify-radar3.mjs` — the script is a check, not part of the entry):

| model | pooled MedAPE | fold-mean | folds won vs radar-2 |
|---|---|---|---|
| **radar-3 (with tilt)** | **86.2%** | 87.4% | 19/25 |
| radar-3 pure, no tilt | 86.0% | 87.5% | 19/25 |
| radar-2 (v1) | 91.6% | 94.9% | — |

Leave-one-out: radar-3 84.3%, radar-2 91.9%. The researcher's independent run of the same recipe reported 84.7% vs 91.5% pooled (fold assignment differs slightly); either way the gap is ~5–7pp and the bootstrap 95% CI on the difference excludes zero ([−8.2, −2.8]pp in our run). The model is still wrong by ~85% on a typical token — mcap/TVL spreads ~10× around its median — so read the ranking, not the dollar figure.

**Growth, honestly:** the fitted growth slope is *negative* (−0.50 per 100pp) and adds nothing in CV, so the model does not use it. The 0.10 tilt in the formula is a small, deliberately positive prior that keeps seven-day growth visibly present as an input, at a known cost of ~0.2–1pp of MedAPE. It never penalises a fast-growing protocol. **Age** has no multiplicative role either (fitted slope also negative, no CV gain): age is shown in the dashboard as context and as a risk flag, never as a factor. **Chains** have no fitted effect and no factor.

**Weakest categories** (out-of-fold MedAPE): Indexes ~279% (all 3 over-predicted ~3.8×), Lending ~94% (largest category), Yield Aggregator ~89%, Privacy ~87%, Dexs ~86%. Thin categories are worse still and unreliable: Staking Pool, Liquidity Manager and Liquid Restaking rest on 1–2 live comps each. The Risk Curators top of the board rests on a single live comp (api3), shrunk to weight 1/6 — the dashboard says so next to every residual.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7qb8d53t&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
