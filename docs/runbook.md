# Burner runbook

Operational procedures for the HPO burner. Written before they were needed, which is the only
time it is possible to write them calmly.

Every script prints the contract's current state and refuses locally if the connected wallet
cannot perform the action, rather than sending a message that bounces. Nothing sends without a
confirmation.

All of them ask for the burner address and default to the deployed one, so pressing enter is
normally right. Give a different address to work on another deployment.

The default is a constant in `wrappers/addresses.ts`, not a derivation. A derived address is
built from the contract's *initial* state, which includes the original owner, so it would stop
reproducing the right address the moment ownership moved — silently, by offering a plausible
default for a contract that does not exist. **If you deploy a replacement burner, update that
constant.**

| Script | What it does |
| --- | --- |
| `showBurner` | Read-only. Counters, next stake, stuck legs, pool depth, owner. |
| `rescue` | Guided recovery from a dead route. Start here in an emergency. |
| `withdrawGram` | Move GRAM out, by amount or all of it. |
| `withdrawJetton` | Move hGRAM, HPO, or any other jetton out. |
| `resetPending` | Square the pending amounts after a withdrawal. |
| `transferOwnership` | Nominate a new owner (step 1 of 2). |
| `claimOwnership` | Accept a nomination (step 2 of 2). |
| `dropOwnership` | Give up the rescue hatch, permanently. |

Run any of them with `npx blueprint run <name>`. All need `blueprint.config.ts`, which is
gitignored because it holds an API key.

## First: is anything actually wrong?

`npx blueprint run showBurner`

A healthy burner shows **zero pending amounts**. Tokens pass through in a few blocks, so a
non-zero pending figure is usually just a snapshot taken mid-cycle. Look again a minute later
before doing anything.

If a pending amount *stays* non-zero, a leg is stuck. There are two very different causes and
they need opposite responses:

- **The leg stalled** — it ran out of gas, or a message was dropped. The contract can finish on
  its own; it just needs another trigger. **Anyone** can send the burner a small amount of GRAM
  (0.05 is enough) and it retries the stuck leg. No owner, no script. Try this first.
- **The route is dead** — DeDust has stopped serving the pool. No number of pokes will help,
  because the swap has nowhere to go. Go to the recovery below.

`showBurner` prints the pool's reserves, which is how you tell them apart.

## Recovering from a dead route

`npx blueprint run rescue`

This is the guided version and does the whole sequence in the right order. It checks whether the
pool is genuinely dead first, and will talk you out of it if the route looks alive.

The order matters, and it is the reason to prefer this over the individual scripts:

1. **Move the jettons out** — hGRAM first, then HPO if any is sitting there.
2. **Reset the pending amounts.** This is the step that is easy to forget and expensive to skip:
   without it the contract still believes those tokens are in its wallets, so every later payment
   retries a leg that cannot succeed — failing, bouncing, and spending gas each time.
3. **Stop the flow at the source.** Set the treasury's `borrower_fee` to `0`. This needs no
   upgrade. Until you do, payments keep arriving at a burner that cannot spend them.
4. **Take the GRAM**, only if abandoning this burner. Taking all of it leaves nothing for storage
   and the account will freeze; leaving it lets the burner resume if the route comes back.

To redeploy against a live pool afterwards: update the route in
`contracts/imports/constants.fc`, `npm run check`, `npx blueprint run deployBurner`, then a
treasury upgrade to point `burner::addr` at the new contract.

## Doing it a step at a time

The individual scripts exist for cases the guided one does not cover — recovering a jetton
somebody sent here by mistake, or taking part of a balance.

**A stray jetton.** `withdrawJetton`, choose "another jetton", give its master address. The
script finds the burner's wallet for it by asking that master, so this works for tokens the
contract knows nothing about.

**Part of the GRAM.** `withdrawGram`, choose "a specific amount". Leave at least 1 GRAM: that is
the reserve funding the swap and burn legs of any cycle already in flight.

**After any jetton withdrawal**, run `resetPending`. It offers to set the pending amounts to what
the wallets really hold, which is almost always the right answer.

## Handing over ownership

Two steps, deliberately, so a mistyped address cannot destroy the rescue hatch.

1. The current owner runs `transferOwnership` and gives the new address. Nothing changes yet —
   the current owner keeps every power they had.
2. The **new owner** runs `claimOwnership` from their own wallet.

If the nominee never claims, the old owner simply stays in charge. Nominating again replaces the
previous nomination.

Prefer a multisig as the owner. It can withdraw everything.

## Giving up ownership

`npx blueprint run dropOwnership`

This is irreversible. Afterwards nobody can withdraw from the contract, ever — no recovery, no
redeploy that reclaims the funds, no governance action that restores access.

Do it when the route has proven itself and you want the burn to be mechanical rather than
trusted. While an owner exists, anyone auditing HPO's supply sees a contract whose owner could
take everything; dropping ownership is what converts "we are relied upon to burn" into "it
burns".

The script checks what is inside first and warns if tokens are sitting there, since dropping
ownership abandons them. It also asks you to type the burner address to confirm.

The burn cycle keeps working exactly as before. Only the hatch goes away.

## What no script can do

The route is compiled in, and there is no `set_code`. The owner cannot point the burner at a
different pool, cannot make it send HPO anywhere but a burn, and cannot change what it is. If the
route needs to change, the answer is always: stop the flow at the treasury, recover what is here,
deploy a new burner, and upgrade the treasury to name it.
