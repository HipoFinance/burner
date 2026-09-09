# HPO burner

A single unowned contract. Any GRAM sent to it is staked into Hipo, the hGRAM buys HPO on
DeDust, and the HPO is burned. It receives a share of each borrower's reward from the Hipo
treasury (`op::take_borrower_fee`) and turns it into permanent TVL plus a permanent reduction in
HPO supply.

Read [docs/specs/2026-09-04-hpo-burner.md](docs/specs/2026-09-04-hpo-burner.md) before changing
anything. Several choices here look like mistakes without the reasoning behind them.

> Terminology matches the `contract` repo: GRAM = the coin, hGRAM = the LST jetton, HPO = the
> governance jetton. The network is still the TON blockchain. Only vendored `stdlib.fc` keeps
> the old TON/hTON names.

## The seven things most likely to bite

**No swap cap and `limit` is 0, deliberately.** Do not "fix" that. An earlier draft had a
`sqrt(2·R·gas)` per-swap cap and it was removed on purpose. How much to trade and in which pool
are protocol decisions about HPO liquidity, settled outside this repo and fixed at deployment;
they are not contract parameters and there is no setter for either.

**The route is compile-time; the assets are not.** Every address and budget in
`contracts/imports/constants.fc` is fixed in the code. Changing one is an upgrade, not a setter —
and `burner::addr` is a constant on the treasury side too, so a *new address* is still a redeploy
plus a treasury upgrade. `scripts/deployBurner.ts` re-reads the live route and refuses on a
mismatch; keep that working. The dry run in `scripts/upgradeBurner.ts` diffs the route across an
upgrade for the same reason.

**The owner is a rescue hatch, and the boundary is the point.** It can send arbitrary messages,
so it can withdraw any asset — that exists because a dead pool would otherwise strand hGRAM here
forever, the one failure nothing else recovers from. `op::withdraw` must never gain the ability
to repoint the burn, send HPO anywhere but a burn, or reach `set_code`; tests pin all three. If
you add an owner op, check it does not widen that boundary. `drop_ownership` is one way, freezes
the code along with the hatch, and is what makes both acceptable; keep it working.

**The contract is upgradable, and that reverses a documented decision — read the spec's
*Upgradability* section before touching it.** It shipped immutable on purpose; `set_code` was
added on 2026-09-09 because the address is referenced by the DefiLlama adapters and redeploying
churns it. The mechanism is the treasury's, op code and all. The safety is entirely in the
ordering inside `upgrade_data`: migrate, then parse with the **new** `load_data()`, then re-check
the owner, then `throw(0)` to commit — so anything wrong reverts whole. Do not reorder it, and do
not mark `upgrade_data` `inline` (it is reached by CALLDICT after `set_c3`, so inlining would
silently run the *old* code's version; there is a test). Migrators live in
`contracts/mock/migrators/` and must contain no `commit()`, no `set_code()`, and compile to
exactly method ids 0 and `0x6d67` — `tests/Upgrade.spec.ts` checks all three.

**The route guard is load-bearing.** Because spending is balance-driven, any returned change
treated as a payment starts a fresh cycle whose own change starts another. The guard covers the
parent, the HPO master, both DeDust vaults, the pool, and both of our jetton wallets — *and*
matches `op::gas_excess` regardless of sender, because the DeDust vault's own hGRAM wallet also
returns change and its address is not a compile-time constant. Both halves were found as real
bugs by the tests. If you touch `recv_internal`, keep `from_route?` complete.

**Pending amounts are what make it resumable.** `hgram_pending` and `hpo_pending` are not
bookkeeping; they are the only thing that lets a failed leg be retried in a contract nobody can
reach into. One leg advances per trigger, so repeated pokes are the recovery tool.

**Every deposit holds back `budget::deposit_forward`, and that is not a fee.** `try_deposit`
names an explicit `coins` so Hipo forwards the difference back as the value of the mint
notification, which pays for that cycle's own swap. Without it the reserve is a single pot with
no headroom — `try_deposit` sweeps down to exactly `budget::reserve` — so several payments in one
block all deposit but only the first swaps. That happened on mainnet on 2026-09-09; the test is
`runs every cycle when several payments land in the same block`, and it must send the payments in
*one transaction*, because sequential sends let each cycle finish and catch nothing. `min_deposit`
must stay above `deposit_forward`, and `deposit_forward` must stay well above Hipo's deposit fee
(~0.0088 GRAM) or `deposit_coins` starts bouncing with `err::insufficient_fee`. `total_deposited`
counts the stake, not the forward.

## Commands

- Install: `npm install`
- Build: `npx blueprint build --all` (FunC → `build/`)
- Test: `npm test` — runs `pretest`, which type-checks first. Prefer it over bare `npx jest`,
  which skips npm scripts and will happily pass code `tsc` rejects.
- Test one file: `npx jest tests/Burner.spec.ts` (then `npm run typecheck` separately)
- Type-check / lint: `npm run typecheck` / `npm run lint`
- Everything, before a deploy: `npm run check`
- Mainnet: `npx blueprint run <script>`; all need `blueprint.config.ts`, which is gitignored
  because it holds an API key. Scripts: `deployBurner`, `showBurner`, `rescue`, `withdrawGram`,
  `withdrawJetton`, `resetPending`, `transferOwnership`, `claimOwnership`, `dropOwnership`,
  `upgradeBurner`.
  Procedures are in [docs/runbook.md](docs/runbook.md). `upgradeBurner` replays the upgrade
  against live state and prints a field diff before it sends anything; keep that working too.

## Layout

- `contracts/burner.fc` — the whole contract
- `contracts/imports/constants.fc` — addresses, op codes, budgets. Every sizing constant has its
  derivation in a comment; keep that true if you change one.
- `contracts/mock/hipo_treasury.fc` — stands in for the treasury's deposit path only
- `contracts/mock/dedust.fc` — stands in for the vault, pool and payout. Modes: fill, refund,
  silent.
- `contracts/mock/burner_v2.fc` — the upgrade target in the tests. It `#include`s the real
  `burner.fc` and adds a version getter, so it cannot drift; an upgrade test has to leave behind a
  contract that still runs a cycle.
- `contracts/mock/migrators/` — one-off storage migrations used by `tests/Upgrade.spec.ts`. Never
  deployed; they ride inside the upgrade message.
- `tests/fixtures/` — the **real** compiled HPO minter/wallet and Hipo parent/wallet
- `tests/helper.ts` — pins every real contract and both stand-ins at the addresses the burner has
  hardcoded, via `setShardAccount`, so a typo in `constants.fc` fails the suite
- `wrappers/rescue.ts` — message builders for the owner scripts. **Keep the tests driving these
  rather than their own copies**: the point is that emergency code is proven before the
  emergency. If you add a withdrawal shape, add it here and cover it.
- `wrappers/upgradeDryRun.ts` — replays an upgrade against real code and storage in a sandbox and
  diffs the result. Same reasoning as `rescue.ts`: the tests drive it, so it is proven before the
  day it matters.
- `wrappers/operate.ts` — shared script preamble. Owner scripts print state and refuse locally
  before sending, so a mistake is a printed line and not a bounce to decode.
- `wrappers/addresses.ts` — the deployed burner and the mainnet addresses the scripts use, in one
  place so they cannot drift. The burner address is a constant, deliberately not derived: a
  derivation keys off initial state including the original owner, so it would go quietly wrong
  once ownership moves. **Update it if you deploy a replacement.**

## Testing notes

Tests assert against the real HPO master's `total_supply` and the real Hipo parent's, so the
counters cannot drift from what actually happened. Deployment itself completes both TEP-89
discoveries, so a fresh fixture is already live — use `forgetWallets()` to exercise the
pre-discovery branch, and prefer delta-based assertions over absolute ones.

`tests/Ownership.spec.ts` covers the rescue hatch, including recovering hGRAM stranded by a dead
pool — the scenario the hatch exists for. Owner ops are handled before the payment branch, so an
owner message is never counted as income or allowed to start a cycle; there is a test for that.

`tests/Upgrade.spec.ts` covers the upgrade path: state and the discovered wallets survive a code
swap and the burner still runs a cycle afterwards; a non-owner and a dropped owner are both
refused; and each way an upgrade can go wrong — unparseable storage, a lost owner, a throwing
migrator, code that cannot answer `upgrade_data` — reverts whole and leaves the burner burning. It
also drives `wrappers/upgradeDryRun.ts`, so the rehearsal an operator approves from is itself
proven, and checks the migrator rules mechanically.

No `MaxGas`-style tests, on purpose: one job, no gas-bounded loops.

## Related repos

- `../contract` — the Hipo treasury that pays this contract, and the source of
  `tests/fixtures/HipoParent` and `HipoWallet`; see its
  `docs/specs/2026-08-31-borrower-fee-hpo-burn.md`
- `../hpo-contract` — the HPO jetton, source of the HPO fixtures
- `../hpo-trader` — Go implementations of the same DeDust and STON.fi cell layouts
