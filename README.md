# HPO burner

Any GRAM sent to this contract is staked into Hipo, the hGRAM buys HPO on DeDust, and the HPO is
burned.

It is the on-chain replacement for the hand-operated burner address in
[`contract/docs/specs/2026-08-31-borrower-fee-hpo-burn.md`](../contract/docs/specs/2026-08-31-borrower-fee-hpo-burn.md):
the Hipo treasury forwards a share of each borrower's reward here on loan recovery, and this
contract turns it into permanent Hipo TVL and a permanent reduction in HPO supply.

```
GRAM in ─▶ Hipo treasury (deposit_coins)
        ─▶ our hGRAM wallet mints, and notifies us
        ─▶ DeDust hGRAM vault (send_tokens, swap in the forward payload)
        ─▶ pool ─▶ HPO vault ─▶ our HPO wallet, which notifies us
        ─▶ our HPO wallet (burn) ─▶ HPO master, total_supply drops
```

HPO is a Notcoin-fork jetton, so the burn genuinely lowers `total_supply` — it is not a transfer
to an unspendable address.

**An owner can recover assets, but cannot redirect the burn or change the code.** Read
[`docs/specs/2026-09-04-hpo-burner.md`](docs/specs/2026-09-04-hpo-burner.md) before changing
anything: several choices here look like mistakes without the reasoning behind them.

## Properties

- **Anyone can pay it.** A bare transfer, a comment, or a small poke all work. That is what lets
  a stuck cycle be advanced with no owner.
- **Everything goes in.** The whole balance above the reserve is staked and burned every time.
  No cap, no minimum output. How much to trade and where are protocol decisions about HPO
  liquidity, fixed at deployment rather than exposed as parameters.
- **Resumable.** Each leg tracks a pending amount, so a leg that fails leaves its tokens
  recorded and any later trigger retries it. Nothing falls out of the cycle unattended.
- **Self-initialising.** It learns both jetton wallets over TEP-89 on the deploy message, and
  believes each answer only from the master it asked.
- **HPO only ever leaves as a burn, hGRAM only ever goes to the DeDust vault.** There is no
  other code path for either.
- **A rescue hatch, not a back door.** The owner can move GRAM, hGRAM, HPO or anything else out
  of the contract — the one failure the design cannot self-heal is a dead pool stranding hGRAM
  inside. The owner cannot repoint the burn, cannot make it send HPO anywhere, and cannot change
  the code; those are compile-time constants and there is no `set_code`.
- **Ownership can be given up.** `drop_ownership` is one way and leaves the cycle working, so
  the contract can run with a hatch while the route is unproven and become permanently immutable
  later, without a redeploy.

## Route

Read from mainnet on 2026-09-04 and hardcoded, because the contract cannot be repointed:

| | |
| --- | --- |
| Hipo treasury | `EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ` |
| Hipo parent (hGRAM) | `EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w` |
| HPO jetton | `EQDQEUr0LPi8m6D6F0Wrvuok7tZbAcr0yn2Y7hK291MMzMjM` |
| DeDust pool (hGRAM/HPO) | `EQCXJu7zUBQILdzt1nIzz_NhDfVZ-FyEdnccFDYDPRaAqfqU` |
| DeDust hGRAM vault | `EQCRjILmJD0ZD7y6POFyicCx20PoypkEwHJ64AMJ7vwkXGjm` |
| DeDust HPO vault | `EQBQ50kTIWywaTa01p_JnHhkaiEukwdt1WPvdHIvP1V5SPMy` |

The parent was read back from the treasury's own `get_treasury_state`, and both vaults from the
DeDust factory's `get_vault_address`, so none of these is a copied constant.

## Commands

- Install: `npm install`
- Build: `npx blueprint build --all`
- Test: `npm test`
- Everything, before a deploy: `npm run check`
- Deploy: `npx blueprint run deployBurner` — asks for the owner, re-reads the route, and refuses
  on any mismatch
- Inspect: `npx blueprint run showBurner` — owner, counters, next stake, stuck legs, pool depth

Owner scripts, written up front rather than during an incident — see
[`docs/runbook.md`](docs/runbook.md):

| Script | What it does |
| --- | --- |
| `rescue` | Guided recovery from a dead route. Start here in an emergency. |
| `withdrawGram` | Move GRAM out, by amount or all of it. |
| `withdrawJetton` | Move hGRAM, HPO, or any other jetton out. |
| `resetPending` | Square the pending amounts after a withdrawal. |
| `transferOwnership` / `claimOwnership` | Hand over ownership, in two steps. |
| `dropOwnership` | Give up the rescue hatch, permanently. |

Mainnet scripts need `blueprint.config.ts`, which is gitignored because it holds an API key.

## Layout

- `contracts/burner.fc` — the contract; `contracts/imports/` holds the addresses and budgets
- `contracts/mock/` — stand-ins for the treasury's deposit path and DeDust, tests only
- `tests/fixtures/` — the **real** compiled HPO jetton and Hipo parent/wallet
- `wrappers/rescue.ts` — the message builders the owner scripts send. The test suite drives
  these same functions, so the code run in an emergency is code that is already proven.
- `wrappers/operate.ts` — shared script preamble: print state, refuse locally, confirm
- `wrappers/`, `tests/`, `scripts/` — otherwise as in the `contract` repo
