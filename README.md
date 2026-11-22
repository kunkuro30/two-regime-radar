# two-regime-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kunkuro30/two-regime-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kunkuro30/two-regime-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar with two value models, not one. Every pre-token protocol in the
sealed DefiLlama snapshot is first sorted into a regime by its seven-day TVL move:
**momentum** (TVL rising) or **mean-reversion** (TVL flat or falling). Each regime is
then priced by its own peer group — the snapshot's own launch-type tokens that trade
today (wrapper, bridge, liquid-staking and exchange tokens are set aside: their market
caps price an underlying asset, not a launch). Inside a regime, a protocol's implied
value is its TVL times that regime's shrunk category median of market-cap/TVL, adjusted
by a robust regression on size and age — an intercept per regime, the two slopes pooled
across regimes, because one regime's peer group is small and a slope fitted on it alone
would be noise. The model is fitted on the snapshot's own figures and nothing else.

The board ranks launch candidates only: protocols that record no token in the snapshot
and pass the same screen the house's watchlist rule draws — no wrapped, staked or bridged
products of a token that already trades, no versioned clones, no exchange products.
WBTC records no token in DefiLlama's protocol entry, but it is Bitcoin on Ethereum, not
a launch still to come, and this radar does not rank it as one.

The program grades itself before it grades anyone else. It prints, on the dashboard's
first screen: the pure empirical-median baseline's error, this model's error on two
holdouts (leave-one-out and a time split), a negative control (every protocol priced by
the *other* regime's model — it does worse, which is what makes the split a finding and
not a decoration), the single worst miss by name, and rank ranges for every row from
150 bootstrap refits of the peer set. A trend-TVL basis was tested and left out: on this
snapshot it moved the leave-one-out error by less than 0.01, so the seven-day move
enters only as the regime split. Nothing is smoothed away; the worst case is on frame
one.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/kit/input/snapshot.json
```

Node 22.18 or later, standard library only, no network. The program reads the sealed
snapshot, writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json`. Two runs on the same snapshot write the same bytes.

---
<sub>Entered on [make.fun](https://make.fun/?ref=67f9yk9n&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
