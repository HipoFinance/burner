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
| `upgradeBurner` | Install new code, with a dry run against live state first. |

Run any of them with `npx blueprint run <name>` — the **name**, not a path. `blueprint run
scripts/rescue.ts` fails with "Could not find file with name": blueprint globs `scripts/` itself
and matches on the bare name. All of them need `blueprint.config.ts`, which is gitignored because
it holds an API key.

## Signing, when the owner is a multisig

The owner should be a multisig, and then nothing on your machine can sign for it. `--deeplink` has
no connected wallet either — blueprint's deeplink provider has no address to report.

Both cases work the same way. Each script asks **which address will sign**, defaulting to the
current owner, and uses that for its local checks so you still get told about a mistake before
sending rather than after a bounce. Then, before every action, it prints the request:

```
  ---- request ------------------------------------------------------------
  To       EQ...the burner
  Value    0.3 GRAM  (300000000 nanoton)
  Bounce   true
  Body     te6cc...
  Note     withdraw 20.856848318 hGRAM to EQ...
  -------------------------------------------------------------------------
```

Those three fields are what a multisig proposal is built from. **Answering "no" to the send is a
normal way to use these scripts**, not an abort: you get the request, the script moves on to the
next step, and you still get walked through them in the right order — which for a rescue is the
part that is easy to get wrong.

The printed body comes from the same builder the send path uses, so it is the cell that would go
on chain rather than a description of one. `tests/Ownership.spec.ts` drives a whole rescue from
these bodies alone, sent raw the way a multisig sends them.

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

**It stops early when there is nothing stuck.** If both jetton wallets are empty and the pool is
alive, there is no rescue to do and it says so. To empty a burner you are retiring — where the
only thing left is the GRAM balance — use `withdrawGram` and choose to sweep it all.

The order matters, and it is the reason to prefer this over the individual scripts:

1. **Move the jettons out** — hGRAM first, then HPO if any is sitting there.
2. **Reset the pending amounts.** This is the step that is easy to forget and expensive to skip:
   without it the contract still believes those tokens are in its wallets, so every later payment
   retries a leg that cannot succeed — failing, bouncing, and spending gas each time.
3. **Stop the flow at the source.** Set the treasury's `borrower_fee` to `0`. This needs no
   upgrade. Until you do, payments keep arriving at a burner that cannot spend them.
4. **Take the GRAM**, only if abandoning this burner. Taking all of it leaves nothing for storage
   and the account will freeze; leaving it lets the burner resume if the route comes back.

To point at a live pool afterwards, prefer an upgrade over a redeploy: update the route in
`contracts/imports/constants.fc`, `npm run check`, `npx blueprint run upgradeBurner`. The address
stays put, so nothing downstream has to follow it, and the dry run prints the route change as a
diff line — check it says what you meant. No migration is needed: the route is compile-time, so
the storage layout does not move.

Only if ownership has been dropped is a redeploy the answer, because then no upgrade is possible:
`npx blueprint run deployBurner`, then a treasury upgrade to point `burner::addr` at the new
contract, and every downstream reference to the address has to be updated too.

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

## Upgrading the code

`npx blueprint run upgradeBurner`

The burner is upgradable so that its address never has to move again — it is referenced from the
DefiLlama adapters and anything else that tracks the burn. The op code and message shape are the
treasury's, so this is the procedure you already know.

The script does the work that makes an upgrade hard to get wrong:

1. It refuses locally if the connected wallet is not the owner.
2. It compiles `Burner` from the working tree, so what you reviewed is what gets sent, and stops
   if that is already the code on chain.
3. It reads the burner's **actual** code and storage off the network and replays the whole upgrade
   in a local sandbox, then prints a field-level diff. Read every line: anything there you did not
   intend is a reason to stop. The diff includes the **route**, which is compile-time and would
   never show up in a storage comparison — a repointed pool is the worst thing an upgrade here can
   do, so it is a line to read rather than something to catch in review.
4. If the upgrade would fail, it says so and sends nothing.
5. For a migration, it prints the migrator source and demands its code hash typed back. A migrator
   is code that runs with the burner's full authority and is *not* part of the reviewed code
   release, so publish its hash alongside the code hash and have every signer read the source.
6. It asks you to type the burner address before sending.

**Does this upgrade need a migration?** Only if the storage layout changes, or if values need
rewriting. Answer "no -- code only" otherwise. Absent is the only way to say "no migration": an
empty cell is not a second way of saying it and would be run and throw.

**Writing a migrator.** Put it in `contracts/mock/migrators/`, add a `wrappers/<Name>.compile.ts`,
and add it to the rule checks in `tests/Upgrade.spec.ts`. Three rules, all checked mechanically
there:

- no `commit()` — it would lock in the queued `set_code` and make every check after the migration
  decorative; a migrator that commits and then writes an unparseable cell is unrecoverable,
  because `recv_internal` loads data before it dispatches and no further upgrade could arrive;
- no `set_code()` — it is appended after the one already queued and the last action wins, so it
  could install code the upgrade message never named;
- fully inlined, so it compiles to exactly method ids 0 and `0x6d67`. `EXECUTE` does not set c3,
  so a non-inlined function would `CALLDICT` into the *burner's* dictionary.

**If it fails.** The upgrade reverts whole — old code, old data, still burning. The cost is a
wasted fee. What the dry run cannot tell you is whether the new code is the code you meant.

## What no script can do

The route is compiled in. The owner cannot point a *running* burner at a different pool, cannot
make it send HPO anywhere but a burn through `op::withdraw`, and cannot reach `set_code` by any
path except `op::upgrade_code` by name. Changing the route now means an upgrade, reviewed as one,
with the route change visible in the dry run's diff.

After `dropOwnership` none of that is available either: the code is frozen along with the hatch,
and the only way to change anything is to deploy a new burner and upgrade the treasury to name
it.
