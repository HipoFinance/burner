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
- It has **no per-swap cap and no minimum output**: the whole balance above the reserve, less the
  gas held back to bring the cycle home, goes in every time.

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

### Each cycle carries its own gas

*Added 2026-09-09, after the mainnet burst described below.*

The reserve is a single pot, and `try_deposit` sweeps the balance down to exactly
`budget::reserve` every time, so there is never headroom above it. That is fine for one payment
at a time and wrong for several at once. On 2026-09-09 the treasury recovered three loans in one
block and sent three fees in one transaction. All three staked. Then the first mint notification
came back, passed the `balance < budget::reserve` guard in `try_swap`, and spent
`budget::swap_gas` on its swap; the second and third notifications found the balance below the
reserve, parked their hGRAM in `hgram_pending` and stopped. 20.86 hGRAM sat unswapped until the
next payment. Nothing was lost — the design self-heals — but two thirds of that block's burn was
deferred by a day.

Raising the reserve does not fix it, because the guard compares against the reserve and the
deposit sweeps back down to it: the headroom is gone before the notifications arrive, whatever
the figure. The fix is to take the shared pot off the path entirely.

`try_deposit` now names an explicit `coins` — `available - budget::deposit_forward` — instead of
asking Hipo to stake the maximum. Hipo forwards everything it does not stake: the treasury does
`raw_reserve(coins, reserve::add_original_balance)` and sends on with `send::unreserved_balance`,
the parent relays with `send::remaining_value`, and our hGRAM wallet passes on everything above
its storage fee with `send::unreserved_balance`. So the held-back 0.5 GRAM arrives as the *value
of the mint notification that starts the swap*, about 0.002 GRAM lighter for the three hops. Each
cycle funds its own leg 2, and the number of payments in flight stops mattering.

Leg 3 already worked this way: the HPO notification arrives carrying what DeDust did not spend of
`budget::swap_forward`, around 0.247 GRAM, against a 0.1 GRAM burn.

The forward is working capital, not a cost. What the swap does not spend stays in the balance and
is swept into the next deposit, so `total_deposited` records the stake and not the forward —
counting the forward on the way out would count it again on the way back in.

The price of naming an explicit `coins` is that the contract now has to stay ahead of Hipo's
deposit fee instead of letting the treasury subtract it: `deposit_coins` throws
`err::insufficient_fee` unless `coins <= incoming - fee`. That fee was 0.0088 GRAM when this was
written, so `budget::deposit_forward` at 0.5 GRAM is a ~50x margin, and `budget::min_deposit` was
raised to 2 GRAM so that the stake is never smaller than the gas riding with it.

This is exact on the instant-mint path, which is the one the treasury runs. With `instant_mint?`
off the deposit goes through a bill and the notification does not arrive until the round settles;
the surplus still travels (`mint_bill` and `bill_burned` both forward their unreserved balance)
but the timing changes, and the fallback is the one that runs today — a leg waits for the next
payment.

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
is `op::burn`. So the owner can take assets out of the contract, but cannot make the contract
itself buy somewhere else or send HPO anywhere. Both halves are pinned by tests.

The third half of that sentence used to be "and cannot become a different program". That is no
longer true; see *Upgradability* below.

`op::reset_pending` exists because otherwise a withdrawal does not finish the job: pulling stuck
hGRAM out leaves `hgram_pending` claiming it is still there, and every later payment would retry
a doomed leg, fail, bounce, re-add itself, and bleed the gas reserve. This squares the books with
reality afterwards.

Ownership transfer is **two-step** — the owner nominates, the nominee claims — matching the HPO
jetton's own `change_admin`/`claim_admin`. A mistyped address therefore cannot silently destroy
the hatch, which for a rescue mechanism is the failure that matters most.

### Upgradability

*Added 2026-09-09, reversing the decision above.*

The contract shipped with no `set_code`, and immutability was named here as one of the three
things the owner must never gain. That is reversed, deliberately, for one reason: **the address is
the identity.** It is referenced from the DefiLlama adapters and from anything else that tracks
the burn, and a mechanism that must be redeployed in order to be improved turns every one of those
references into a moving target — the first redeploy, two days in, already forced one adapter to
follow two addresses for a contract that had only ever run for two days. One more deployment buys
a permanent address.

Be exact about what this costs, because "the owner can now change the code" sounds worse and is
subtler than it is:

- It grants **no new power over what is here today.** `op::withdraw` already sends arbitrary
  messages, so the owner could already move every asset out, HPO included. Anyone who trusted the
  contract yesterday was already trusting the owner with its entire balance.
- It grants power over **what arrives tomorrow.** The code that decides where a borrower fee goes
  can be replaced, with no further visible act, and a reader of this source can no longer conclude
  from the source alone what a future fee will do. That is a real loss and it is the reason this
  section exists rather than a line in a changelog.

`op::drop_ownership` remains the answer, and it now answers for more than it did: dropping
ownership closes the rescue hatch and freezes the code in the same one-way step. The end state is
unchanged — a contract nobody can reach into — and the path there is the same one it always was.

**The mechanism is the treasury's**, deliberately: the same op code (`0x3d6a29b5`), the same
message shape, and the same migrator contract, so one upgrade procedure covers both contracts.
`upgrade_code` installs the new code, calls `set_c3`, and then calls `upgrade_data` — which
dispatches into the code just installed, so a version validates its own arrival. In order:

1. the migration carried by the message runs, if there is one;
2. the **new** `load_data()` parses what it produced;
3. the owner check runs against the value that parse yielded;
4. `throw(0)` commits.

Everything before step 4 is uncommitted, so an upgrade whose code cannot read this storage, whose
migration produces something the new code misreads, or that would leave nobody able to reach the
contract, reverts whole — old code, old data, still burning. `tests/Upgrade.spec.ts` covers each
of those.

That ordering is not decorative. `recv_internal` calls `load_data()` before it dispatches, so a
burner whose storage does not parse could not receive another `upgrade_code` either; committing a
bad migration is the one unrecoverable failure available here, and steps 2 and 3 are what stand in
front of it. The same reasoning is why a migrator must contain no `commit()` and no `set_code()`,
and must compile to exactly method ids 0 and `0x6d67` — all three are checked mechanically in
`tests/Upgrade.spec.ts` rather than left to review.

`scripts/upgradeBurner.ts` reads the burner's real code and storage off the network, replays the
whole upgrade in a sandbox, and prints a field-level diff before asking for anything. The diff
includes the **route**, which is compile-time and so would never show up in a storage comparison —
repointing the burn is the most consequential thing an upgrade here can do, and it should be a
line an operator reads rather than something to catch in a code review.

### The cost, and the way out of it

While an owner exists, the burn is **trusted rather than mechanical**. Anyone auditing HPO's
tokenomics sees a contract whose owner can withdraw everything, and "burned" becomes "we are
relied upon to burn". For a mechanism whose whole purpose is a credible supply link, that is a
genuine cost, not a theoretical one.

`op::drop_ownership` is the answer. It is one way, clears the pending nomination too, freezes the
code along with the hatch, and leaves the burn cycle working exactly as before — so the contract can run with a hatch while the route
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

`total_deposited` is what Hipo staked, which is a whole `budget::deposit_forward` short of what
each deposit message carried; the difference is gas that comes back and is staked by a later
deposit, so counting it on the way out would count it twice.

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
