# HPO burner

## Problem

`contract/docs/specs/2026-08-31-borrower-fee-hpo-burn.md` routes a share of each borrower's
reward to a `burner` address hardcoded in the treasury, and says the address is "operated by
hand at first: the proceeds are used to buy HPO on the open market and burn it. Later it is
replaced by a contract that swaps and burns on-chain."

This is that contract.

## What it does

Any GRAM that arrives is staked into Hipo, the hGRAM is spent buying HPO on DeDust, and the HPO
is burned. The treasury is the intended payer — `op::take_borrower_fee` on every loan recovery —
but the contract does not check who paid. A bare transfer, a comment, or a small poke from a
stranger all work identically, which is what lets anyone advance a stuck cycle with no owner.

```
GRAM in ─▶ Hipo treasury (deposit_coins)
        ─▶ our hGRAM wallet mints, and notifies us
        ─▶ DeDust hGRAM vault (send_tokens, swap in the forward payload)
        ─▶ pool ─▶ HPO vault ─▶ our HPO wallet, which notifies us
        ─▶ our HPO wallet (burn) ─▶ HPO master, total_supply drops
```

HPO is a Notcoin-fork jetton, so `op::burn` from the wallet owner genuinely reduces
`total_supply`. This is not a transfer to an unspendable address.

## Sizing

Two parameters of this contract look surprising and are deliberate:

- It routes through the **HPO/hGRAM** pair on DeDust rather than an HPO/GRAM pair.
- It has **no per-swap cap and no minimum output**: the whole balance above the reserve goes in
  every time.

Both are protocol-level decisions about where HPO liquidity should sit and how the fee should
reach it, not properties of the mechanism. They are recorded separately and are not parameters
this contract exposes — there is no setter for either, and changing them means deploying a new
burner.

What follows documents the mechanism.

## Decisions

### DeDust, not STON.fi

DeDust has no pTON. A GRAM-side STON.fi v2 swap has to enter through a pTON wallet, which means
two extra hardcoded addresses and an extra indirection. On DeDust the whole swap is one jetton
transfer into the vault with the swap as its forward payload. For a contract nobody can fix
after deployment, fewer moving parts and fewer constants that can go stale is worth real money.

### Staking rather than buying HPO with GRAM

Routing through hGRAM means the fee also becomes permanent Hipo TVL: the staked GRAM stays in
the protocol, and the hGRAM ends up with whoever sells HPO into the burner.

The burner stakes the GRAM itself rather than the treasury minting hGRAM directly into it. That
question was settled on cost: **Hipo's deposit fee
is 0.0088 GRAM, which is 0.04% of a 22.9 GRAM payment.** Saving it is not worth adding a mint to
`recover_stake_result` — a gas-tight, non-bounceable, `ignore_errors` path in the lending loop
that the borrower-fee spec deliberately kept thin.

Leaving the treasury sending plain GRAM also keeps it asset-agnostic, so a future change of burn
burn strategy needs no treasury upgrade.

`instant_mint` is `true` and is expected to stay true — the protocol's answer to the problem it
solves is a deposit haircut, not turning it off — so the deposit mints immediately and the
bill-NFT path never runs. If it were ever turned off, deposits would return a bill instead and
this contract would stall with GRAM in hand rather than lose it.

### No cap and no minimum output

`limit` on the swap is 0 and there is no maximum deposit, per the sizing decision above.

It is worth being explicit that this is not an oversight a future change should correct. A
contract cannot read pool reserves synchronously on TON, so any stored bound would be stale
anyway; and the burner's buys are predictable in size and schedule, so anyone can pre-position
against them without needing a mempool. Neither is addressable at the contract level. Sizing and
slippage belong to the liquidity decision, not to this code.

There is still a **minimum deposit** of 1 GRAM. That is a dust floor, not a slippage control: it
stops returned change and stray small amounts from spending more in gas than they are worth.

### Balance-driven, with pending amounts

Each trigger spends `balance - reserve`, and each leg acts on a *pending amount* rather than on
the message that woke it. `hgram_pending` and `hpo_pending` are what make the cycle resumable: a
leg that cannot be sent leaves its amount recorded, and any later trigger retries it.

This matters more than it would elsewhere. Routing through hGRAM adds a second failure-capable
leg, and in a contract with no owner, tokens that fall out of the cycle with nothing tracking
them are stranded forever.

One leg is advanced per trigger — burn first, then swap, then a new deposit — so a single
transaction never has to fund three legs at once, and repeated pokes are a sufficient recovery
tool for anyone.

`budget::reserve` is 1 GRAM rather than a storage-rent figure, because it has to fund the swap
and burn legs of a cycle that is *already in flight*, after the GRAM has left.

### The route guard, and the cascade it prevents

**This is the subtle part, and the test suite caught both halves of it as real bugs.**

Money comes back out of the contract's own machinery constantly: discovery replies, the mint's
leftover, unspent swap forward amounts, DeDust refunds, and the burn's excesses from the HPO
master. Because spending is balance-driven, any of these treated as a payment starts a fresh
deposit whose own change starts another.

In an earlier single-leg version, omitting just the HPO master from the guard turned one payment
into **40 chained swaps**. Here the guard covers the parent, the HPO master, both DeDust vaults,
the pool, and both of our own jetton wallets.

The second half was harder: **the DeDust vault's own hGRAM wallet also returns change**, and its
address is derived from the vault and the parent, so it cannot be a compile-time constant. The
guard therefore also matches on `op::gas_excess` regardless of sender — an excess message is
returned change by definition, whoever sends it. That check is what makes `total_received` mean
income rather than the contract's own money coming back.

The Hipo treasury is deliberately *absent* from the guard: it is the payer, and on the deposit
path it sends no change back — the leftover rides with the mint notification instead.

### An owner, as a rescue hatch

The contract shipped immutable, and that was changed deliberately after review.

The reasoning that changed it: **the stop valve bounds future flow but recovers nothing already
inside.** Governance setting `borrower_fee` to 0 stops more GRAM arriving, but if DeDust stops
serving the pool, whatever hGRAM is already sitting in the burner's wallet is stranded forever,
and a poke retries the swap against a route that will never answer. Every other failure in this
design self-heals. That one does not, and the funds are real.

So there is an owner, and it can move anything: GRAM, hGRAM, HPO, or a jetton that does not exist
yet. `op::withdraw` takes a mode and a message cell and sends it raw, rather than enumerating one
op per asset — the shape of a rescue cannot be predicted, because if it could it would have been
designed out instead.

**What the owner cannot do** is as important as what it can. The pool, the vault, the treasury
and both masters are compile-time constants, and the only op the contract ever sends towards HPO
is `op::burn`. There is no `set_code`. So the owner can take assets out of the contract, but
cannot make the contract itself buy somewhere else, send HPO anywhere, or become a different
program. Both halves are pinned by tests.

`op::reset_pending` exists because otherwise a withdrawal does not finish the job: pulling stuck
hGRAM out leaves `hgram_pending` claiming it is still there, and every later payment would retry
a doomed leg, fail, bounce, re-add itself, and bleed the gas reserve. This squares the books with
reality afterwards.

Ownership transfer is **two-step** — the owner nominates, the nominee claims — matching the HPO
jetton's own `change_admin`/`claim_admin`. A mistyped address therefore cannot silently destroy
the hatch, which for a rescue mechanism is the failure that matters most.

### The cost, and the way out of it

While an owner exists, the burn is **trusted rather than mechanical**. Anyone auditing HPO's
tokenomics sees a contract whose owner can withdraw everything, and "burned" becomes "we are
relied upon to burn". For a mechanism whose whole purpose is a credible supply link, that is a
genuine cost, not a theoretical one.

`op::drop_ownership` is the answer. It is one way, clears the pending nomination too, and leaves
the burn cycle working exactly as before — so the contract can run with a hatch while the route
is unproven and be made permanently immutable later, by choice, without a redeploy or a treasury
upgrade. The credibility is recoverable; the stranded funds would not have been.

### Self-initialising

The burner learns both jetton wallets over TEP-89 — the hGRAM one from the Hipo parent, the HPO
one from the HPO master — and only believes each answer from the master it asked. That is what
makes it safe to act on a `transfer_notification` later: one from any other address is ignored,
so a worthless token cannot induce a swap or a burn or spend the gas reserve. The two legs are
told apart purely by which of the two wallets sent the notification.

Discovery runs on the deploy message itself, so the contract is live from block one with no
operator step. Until both answers land, GRAM accumulates and is swept afterwards.

## What the treasury sends

Unchanged from the borrower-fee spec, and confirmed against `treasury.fc:1546-1556`:
non-bounceable, `op::take_borrower_fee = 0x5e2d81f4` + `query_id:uint64`, value = `burn_share`,
mode `pay_gas_separately + ignore_errors`, basechain only.

Because that send is non-bounceable with `ignore_errors`, nothing this contract does can wedge
`recover_stake_result` or block the lending path.

## Accounting

`get_burner_data()` returns `(hgram_wallet, hpo_wallet, total_received, total_deposited,
total_swapped, total_burned)`. `total_burned` is asserted in the tests against the HPO master's
actual `total_supply` drop, so the counter cannot silently drift; a leg that bounces rolls its
counters back.

`get_progress()` returns the pending amounts and the per-leg counts — a pending amount that does
not clear is the signal that a leg is stuck and a poke is needed. `get_depositable()`
distinguishes "waiting for the threshold" from "stuck". `get_route()` returns the hardcoded
addresses, which is what `scripts/deployBurner.ts` checks against the chain before deploying.

Log topics: `received` (1), `deposit` (2), `swap` (3), `burn` (4), `discovery` (5).

## Testing

24 tests, run against **real compiled contracts wherever one exists**: the real HPO minter and
wallet from `hpo-contract`, and the real Hipo parent and wallet from `contract`. Only the
treasury's deposit path and DeDust are stand-ins, and both are pinned to their real mainnet
addresses via `setShardAccount` — so a typo in `constants.fc` fails the suite rather than
reaching mainnet.

Because the real Hipo parent and wallet are in the loop, the mint, the notification and
`send_tokens` all run production code.

Coverage includes: the full three-leg cycle asserted against both `total_supply` figures; that a
large payment goes in uncapped; that `limit` is 0; the cascade the route guard prevents;
recovery when the treasury refuses a deposit and when DeDust refuses a swap; rejection of
foreign notifications; that HPO only ever leaves as a burn and hGRAM only ever goes to the
vault; the dust floor; and that no message from anyone changes the code.

A second suite covers the rescue hatch: recovering GRAM, recovering hGRAM stranded by a dead
pool (the case it exists for), that `reset_pending` stops the doomed retries, that no other
address can use any of it, that an owner message is never mistaken for a payment, the two-step
transfer including a nominee who never claims, and that dropping ownership is irreversible,
clears a pending nomination, and leaves the cycle working.

There are no `MaxGas`-style gas-bound tests. The contract has one job and no gas-bounded loops,
so pinning gas constants would be ceremony rather than protection.

## Deployment

1. `npm run check` — type-check, lint, 24 tests.
2. `npx blueprint run deployBurner` — re-reads the treasury's parent, the pool's assets and
   reserves, and the vault's asset, and **refuses to deploy** on any mismatch.
3. The script asks for the owner address before deploying. It is part of the state the address
   is derived from, so it must be decided up front; prefer a multisig. Take the printed
   `burner::wc` / `burner::addr` into
   `contract/contracts/imports/constants.fc`, replacing the zero placeholder.
4. Ship the treasury upgrade. `total_borrowers_stake` was 0 on 2026-09-04, the window the
   migrator wants.
5. Only then set `borrower_fee`. While it is 0 the treasury sends nothing, so a wrong constant
   is inert until that call.

## Operating it

The owner scripts are written up front, not left to be improvised during an incident:
`rescue` (guided recovery), `withdrawGram`, `withdrawJetton`, `resetPending`,
`transferOwnership`, `claimOwnership`, `dropOwnership`. Procedures are in
[`docs/runbook.md`](../runbook.md).

Two things make them safer than a hand-built message would be.

The message builders live in `wrappers/rescue.ts` and **the test suite drives the same
functions**, so the cell layouts an operator relies on in an emergency are the ones already
proven against real jetton code — including HPO through a stock TEP-74 wallet and hGRAM through
Hipo's, which share an op code but are different contracts.

Every script prints the contract's real state and **refuses locally** when the connected wallet
cannot perform the action, instead of sending a message that bounces. Under stress, a printed
line beats a failed transaction hash.

The runbook also records the distinction that matters most when something looks wrong: a stalled
leg needs a poke, which anyone can send and which needs no owner, while a dead route needs the
recovery. `showBurner` prints the pool reserves, which is how they are told apart.

## Deliberately not done

- **A swap cap or slippage limit.** See "Sizing" and "No cap and no minimum output" above.
  An earlier draft had a per-swap cap; it was removed on purpose.
- **Multi-DEX or split routing.** The contract trades in one pool by design; which pool is a
  liquidity decision, not something the contract arbitrates.
- **An aggregator.** On-chain routing needs a quote, and aggregator quotes are computed
  off-chain; that needs a keeper, which contradicts an unattended contract.
- **Gas-bound tests.** No loops, one job.
- **A `set_code` upgrade path.** The owner can rescue assets but cannot change what the contract
  is. Adding upgradeability would make "burner" a name rather than a guarantee, and the stranded-
  funds problem it would solve is already solved by withdrawal.
- **A pause flag.** `reset_pending` plus withdrawal already covers a dead route, and governance
  can stop the flow at the treasury.
