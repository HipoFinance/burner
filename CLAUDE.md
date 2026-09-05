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

## The five things most likely to bite

**No swap cap and `limit` is 0, deliberately.** Do not "fix" that. An earlier draft had a
`sqrt(2·R·gas)` per-swap cap and it was removed on purpose. How much to trade and in which pool
are protocol decisions about HPO liquidity, settled outside this repo and fixed at deployment;
they are not contract parameters and there is no setter for either.

**The route is immutable; the assets are not.** Every address and budget in
`contracts/imports/constants.fc` is fixed at deployment, and there is no `set_code`. A wrong
constant is a redeploy plus a treasury upgrade, because `burner::addr` is a constant on the
treasury side too. `scripts/deployBurner.ts` re-reads the live route and refuses on a mismatch;
keep that working.

**The owner is a rescue hatch, and the boundary is the point.** It can send arbitrary messages,
so it can withdraw any asset — that exists because a dead pool would otherwise strand hGRAM here
forever, the one failure nothing else recovers from. It must never gain the ability to repoint
the burn, send HPO anywhere but a burn, or change the code. Tests pin all three. If you add an
owner op, check it does not widen that boundary. `drop_ownership` is one way and makes the
contract permanently immutable; keep it working, it is what makes the hatch acceptable.

**The route guard is load-bearing.** Because spending is balance-driven, any returned change
treated as a payment starts a fresh cycle whose own change starts another. The guard covers the
parent, the HPO master, both DeDust vaults, the pool, and both of our jetton wallets — *and*
matches `op::gas_excess` regardless of sender, because the DeDust vault's own hGRAM wallet also
returns change and its address is not a compile-time constant. Both halves were found as real
bugs by the tests. If you touch `recv_internal`, keep `from_route?` complete.

**Pending amounts are what make it resumable.** `hgram_pending` and `hpo_pending` are not
bookkeeping; they are the only thing that lets a failed leg be retried in a contract nobody can
reach into. One leg advances per trigger, so repeated pokes are the recovery tool.

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
  `withdrawJetton`, `resetPending`, `transferOwnership`, `claimOwnership`, `dropOwnership`.
  Procedures are in [docs/runbook.md](docs/runbook.md).

## Layout

- `contracts/burner.fc` — the whole contract
- `contracts/imports/constants.fc` — addresses, op codes, budgets. Every sizing constant has its
  derivation in a comment; keep that true if you change one.
- `contracts/mock/hipo_treasury.fc` — stands in for the treasury's deposit path only
- `contracts/mock/dedust.fc` — stands in for the vault, pool and payout. Modes: fill, refund,
  silent.
- `tests/fixtures/` — the **real** compiled HPO minter/wallet and Hipo parent/wallet
- `tests/helper.ts` — pins every real contract and both stand-ins at the addresses the burner has
  hardcoded, via `setShardAccount`, so a typo in `constants.fc` fails the suite
- `wrappers/rescue.ts` — message builders for the owner scripts. **Keep the tests driving these
  rather than their own copies**: the point is that emergency code is proven before the
  emergency. If you add a withdrawal shape, add it here and cover it.
- `wrappers/operate.ts` — shared script preamble. Owner scripts print state and refuse locally
  before sending, so a mistake is a printed line and not a bounce to decode.

## Testing notes

Tests assert against the real HPO master's `total_supply` and the real Hipo parent's, so the
counters cannot drift from what actually happened. Deployment itself completes both TEP-89
discoveries, so a fresh fixture is already live — use `forgetWallets()` to exercise the
pre-discovery branch, and prefer delta-based assertions over absolute ones.

`tests/Ownership.spec.ts` covers the rescue hatch, including recovering hGRAM stranded by a dead
pool — the scenario the hatch exists for. Owner ops are handled before the payment branch, so an
owner message is never counted as income or allowed to start a cycle; there is a test for that.

No `MaxGas`-style tests, on purpose: one job, no gas-bounded loops.

## Related repos

- `../contract` — the Hipo treasury that pays this contract, and the source of
  `tests/fixtures/HipoParent` and `HipoWallet`; see its
  `docs/specs/2026-08-31-borrower-fee-hpo-burn.md`
- `../hpo-contract` — the HPO jetton, source of the HPO fixtures
- `../hpo-trader` — Go implementations of the same DeDust and STON.fi cell layouts
