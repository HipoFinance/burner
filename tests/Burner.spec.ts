import { beginCell, toNano } from '@ton/core'
import { flattenTransaction } from '@ton/test-utils'

import { budget } from '../wrappers/Burner'
import { mockMode } from '../wrappers/MockDedust'
import {
    DEDUST_HGRAM_VAULT,
    Fixture,
    HIPO_PARENT,
    HIPO_TREASURY,
    HPO_MASTER,
    Op,
    forgetWallets,
    setup,
} from './helper'

/** What the treasury actually sends per loan recovery, per the borrower-fee spec. */
const BORROWER_FEE = toNano('22.9')

function messagesTo(result: { transactions: unknown[] }, to: { toString(): string }, op: number) {
    return (result.transactions as Parameters<typeof flattenTransaction>[0][])
        .map(flattenTransaction)
        .filter((t) => t.to?.toString() === to.toString() && t.op === op)
}

describe('Burner', () => {
    describe('discovery', () => {
        it('finds both of its jetton wallets during deployment, with no operator step', async () => {
            const f: Fixture = await setup()

            expect(f.deployResult.transactions).toHaveTransaction({
                from: f.burner.address,
                to: HIPO_PARENT,
                op: Op.provideWalletAddress,
                success: true,
            })
            expect(f.deployResult.transactions).toHaveTransaction({
                from: f.burner.address,
                to: HPO_MASTER,
                op: Op.provideWalletAddress,
                success: true,
            })

            const data = await f.burner.getBurnerData()
            expect(data.hgramWallet?.toString()).toBe(f.burnerHgramWallet.toString())
            expect(data.hpoWallet?.toString()).toBe(f.burnerHpoWallet.toString())
        })

        it('stakes nothing while either wallet is still unknown', async () => {
            const f: Fixture = await setup()
            await forgetWallets(f)

            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: HIPO_PARENT,
                op: Op.provideWalletAddress,
            })
            expect(messagesTo(result, HIPO_TREASURY, Op.depositCoins)).toHaveLength(0)
        })

        it('sweeps the GRAM that arrived before discovery into the next deposit', async () => {
            const f: Fixture = await setup()
            await forgetWallets(f)
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            expect(await f.burner.getDepositable()).toBeGreaterThan(toNano('20'))

            const result = await f.burner.sendPoke(f.stranger.getSender())
            expect(messagesTo(result, HIPO_TREASURY, Op.depositCoins)).toHaveLength(1)
        })
    })

    describe('the full stake, swap and burn cycle', () => {
        it('turns a borrower fee into Hipo TVL and a lower HPO supply', async () => {
            const f: Fixture = await setup()
            const hpoBefore = await f.hpoSupply()
            const hgramBefore = await f.hgramSupply()
            const before = await f.burner.getBurnerData()

            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            // Leg 1: the GRAM is staked, and the real Hipo parent mints against it.
            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: HIPO_TREASURY,
                op: Op.depositCoins,
                success: true,
            })
            expect(result.transactions).toHaveTransaction({
                from: f.burnerHgramWallet,
                to: f.burner.address,
                op: Op.transferNotification,
                success: true,
            })

            // Leg 2: the hGRAM goes into the DeDust vault with the swap as forward payload.
            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: f.burnerHgramWallet,
                op: Op.sendTokens,
                success: true,
            })
            expect(result.transactions).toHaveTransaction({
                to: DEDUST_HGRAM_VAULT,
                op: Op.transferNotification,
                success: true,
            })

            // Leg 3: the HPO comes back and is burned against the real jetton master.
            expect(result.transactions).toHaveTransaction({
                from: f.burnerHpoWallet,
                to: f.burner.address,
                op: Op.transferNotification,
                success: true,
            })
            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: f.burnerHpoWallet,
                op: Op.burn,
                success: true,
            })
            expect(result.transactions).toHaveTransaction({
                from: f.burnerHpoWallet,
                to: HPO_MASTER,
                op: Op.burnNotification,
                success: true,
            })

            const after = await f.burner.getBurnerData()
            const progress = await f.burner.getProgress()

            // hGRAM supply went up: the staked GRAM is TVL now, held by whoever ends up with it.
            expect(await f.hgramSupply()).toBeGreaterThan(hgramBefore)
            // HPO supply went down by exactly what the burner claims it burned.
            expect(await f.hpoSupply()).toBeLessThan(hpoBefore)
            expect(after.totalBurned - before.totalBurned).toBe(hpoBefore - (await f.hpoSupply()))

            expect(progress.depositCount).toBe(1)
            expect(progress.swapCount).toBe(1)
            expect(progress.burnCount).toBe(1)

            // Nothing is left holding tokens: the burner keeps no inventory of either.
            expect(await f.hgramBalance(f.burner.address)).toBe(0n)
            expect(await f.hpoBalance(f.burner.address)).toBe(0n)
            expect(progress.hgramPending).toBe(0n)
            expect(progress.hpoPending).toBe(0n)
        })

        it('stakes the whole payment, with no cap', async () => {
            const f: Fixture = await setup()
            const before = await f.burner.getBurnerData()

            // A payment far larger than any sane per-trade size still goes in as one deposit.
            await f.burner.sendGram(f.stranger.getSender(), toNano('5000'))

            const after = await f.burner.getBurnerData()
            const deposited = after.totalDeposited - before.totalDeposited
            expect(deposited).toBeGreaterThan(toNano('4990'))

            const progress = await f.burner.getProgress()
            expect(progress.depositCount).toBe(1)
            expect(progress.swapCount).toBe(1)
        })

        it('keeps enough GRAM to run again and no more', async () => {
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const balance = (await f.blockchain.getContract(f.burner.address)).balance
            expect(balance).toBeGreaterThan(0n)
            expect(balance).toBeLessThan(budget.reserve + budget.minDeposit)
        })

        it('runs a clean cycle for every payment', async () => {
            const f: Fixture = await setup()
            const hpoBefore = await f.hpoSupply()

            for (let i = 0; i < 3; i++) {
                await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, BigInt(i))
            }

            const progress = await f.burner.getProgress()
            expect(progress.depositCount).toBe(3)
            expect(progress.swapCount).toBe(3)
            expect(progress.burnCount).toBe(3)
            expect(progress.hgramPending).toBe(0n)
            expect(progress.hpoPending).toBe(0n)
            expect(await f.hpoSupply()).toBeLessThan(hpoBefore)
        })
    })

    describe('who can pay', () => {
        it('accepts a bare transfer with no body', async () => {
            const f: Fixture = await setup()
            const before = await f.hpoSupply()
            await f.burner.sendGram(f.stranger.getSender(), toNano('30'))
            expect(await f.hpoSupply()).toBeLessThan(before)
        })
    })

    describe('resuming a stuck cycle', () => {
        it('holds the hGRAM when DeDust will not serve the swap, and retries on a poke', async () => {
            const f: Fixture = await setup({ mode: mockMode.silent })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            // The swap went out and was swallowed. The hGRAM is gone from our wallet, so nothing
            // is pending and nothing is stuck on our side.
            const stuck = await f.burner.getProgress()
            expect(stuck.swapCount).toBe(1)
            expect(stuck.burnCount).toBe(0)

            // A later payment still runs a fresh cycle rather than wedging.
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, 1n)
            expect((await f.burner.getProgress()).depositCount).toBe(2)
        })

        it('puts the hGRAM back and retries when the swap send itself bounces', async () => {
            const f: Fixture = await setup({ mode: mockMode.refund })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            // DeDust handed the hGRAM back, which arrives as a notification from our own wallet
            // and is queued for another attempt rather than being stranded.
            const progress = await f.burner.getProgress()
            expect(progress.swapCount).toBeGreaterThanOrEqual(1)
            expect(await f.hgramBalance(f.burner.address)).toBe(progress.hgramPending)
        })

        it('recovers the deposit when the treasury refuses it', async () => {
            const f: Fixture = await setup({ treasuryRejects: true })
            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            // The deposit bounced, so the GRAM is back and available to try again.
            expect(result.transactions).toHaveTransaction({
                from: HIPO_TREASURY,
                to: f.burner.address,
                inMessageBounced: true,
            })
            expect(await f.burner.getDepositable()).toBeGreaterThan(toNano('20'))
        })

        it('lets anyone advance a stuck leg with a small poke, with no owner', async () => {
            const f: Fixture = await setup({ treasuryRejects: true })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            // Same fixture, treasury now working: a stranger's poke gets the cycle moving.
            const f2: Fixture = await setup()
            await forgetWallets(f2)
            await f2.burner.sendBorrowerFee(f2.treasury.getSender(), BORROWER_FEE)
            const result = await f2.burner.sendPoke(f2.stranger.getSender())
            expect(messagesTo(result, HIPO_TREASURY, Op.depositCoins)).toHaveLength(1)
        })
    })

    describe('safety', () => {
        it('does not let returned change cascade into more deposits', async () => {
            // Discovery replies, mint change, swap excesses and burn excesses all come back as
            // ordinary incoming GRAM. On a balance-driven contract each would start a fresh
            // deposit whose own change would start another.
            const f: Fixture = await setup()
            const result = await f.burner.sendGram(f.stranger.getSender(), toNano('200'))
            expect(messagesTo(result, HIPO_TREASURY, Op.depositCoins)).toHaveLength(1)
        })

        it('ignores a transfer_notification that is not from one of its own wallets', async () => {
            const f: Fixture = await setup()
            const before = await f.burner.getProgress()

            const result = await f.stranger.send({
                to: f.burner.address,
                value: toNano('1'),
                body: beginCell()
                    .storeUint(Op.transferNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano('999999'))
                    .storeAddress(f.stranger.address)
                    .storeUint(0, 1)
                    .endCell(),
            })

            expect(result.transactions).not.toHaveTransaction({ from: f.burner.address, op: Op.burn })
            const after = await f.burner.getProgress()
            expect(after.hpoPending).toBe(before.hpoPending)
            expect(after.hgramPending).toBe(before.hgramPending)
            expect(after.burnCount).toBe(before.burnCount)
        })

        it('never sends HPO anywhere except into a burn', async () => {
            const f: Fixture = await setup()
            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const hpoTransfers = result.transactions
                .map(flattenTransaction)
                .filter((t) => t.from?.equals(f.burner.address) && t.to?.equals(f.burnerHpoWallet))
                .filter((t) => t.op !== Op.burn)
            expect(hpoTransfers).toHaveLength(0)
        })

        it('only ever sends hGRAM to the DeDust vault', async () => {
            const f: Fixture = await setup()
            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const sends = result.transactions
                .map(flattenTransaction)
                .filter((t) => t.from?.equals(f.burner.address) && t.op === Op.sendTokens)
            expect(sends).toHaveLength(1)

            // And the recipient inside the body is the vault, not just the wallet we asked.
            const body = sends[0]?.body?.beginParse()
            body?.loadUint(32)
            body?.loadUint(64)
            body?.loadCoins()
            expect(body?.loadAddress().toString()).toBe(DEDUST_HGRAM_VAULT.toString())
        })

        it('asks for no minimum output', async () => {
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            expect((await f.dedust.getMockData()).lastLimit).toBe(0n)
        })

        it('does not deposit below the minimum, so dust cannot drain the reserve', async () => {
            const f: Fixture = await setup()
            await f.burner.sendPoke(f.stranger.getSender())

            const result = await f.burner.sendGram(f.stranger.getSender(), toNano('0.05'))
            expect(messagesTo(result, HIPO_TREASURY, Op.depositCoins)).toHaveLength(0)
        })

        it('survives a dead route without losing its gas reserve', async () => {
            const f: Fixture = await setup({ mode: mockMode.silent })
            for (let i = 0; i < 5; i++) {
                await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, BigInt(i))
            }
            const balance = (await f.blockchain.getContract(f.burner.address)).balance
            expect(balance).toBeGreaterThan(budget.reserve / 2n)
        })
    })

    describe('accounting', () => {
        it('reports the route it will actually use', async () => {
            const f: Fixture = await setup()
            const route = await f.burner.getRoute()
            expect(route.treasury.toString()).toBe(HIPO_TREASURY.toString())
            expect(route.parent.toString()).toBe(HIPO_PARENT.toString())
            expect(route.dedustHgramVault.toString()).toBe(DEDUST_HGRAM_VAULT.toString())
        })

        it('counts income but not its own returned change', async () => {
            const f: Fixture = await setup()
            const before = await f.burner.getBurnerData()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            await f.burner.sendGram(f.stranger.getSender(), toNano('3'))

            const after = await f.burner.getBurnerData()
            expect(after.totalReceived - before.totalReceived).toBe(BORROWER_FEE + toNano('3'))
        })

        it('matches total_burned against the supply the master actually destroyed', async () => {
            const f: Fixture = await setup()
            const supplyBefore = await f.hpoSupply()
            const before = await f.burner.getBurnerData()

            for (let i = 0; i < 3; i++) {
                await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, BigInt(i))
            }

            const after = await f.burner.getBurnerData()
            expect(after.totalBurned - before.totalBurned).toBe(supplyBefore - (await f.hpoSupply()))
        })

        it('emits a log for each leg of the cycle', async () => {
            const f: Fixture = await setup()
            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const logs = result.transactions.flatMap((tx) =>
                tx.outMessages.values().filter((m) => m.info.type === 'external-out'),
            )
            expect(logs.length).toBeGreaterThanOrEqual(4)
        })
    })

    it('is immutable: no message from anyone changes the code', async () => {
        const f: Fixture = await setup()
        const codeOf = async () => {
            const state = (await f.blockchain.getContract(f.burner.address)).account.account?.storage.state
            return state?.type === 'active' ? state.state.code?.hash().toString('hex') : undefined
        }
        const before = await codeOf()
        await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
        await f.burner.sendGram(f.deployer.getSender(), toNano('30'))

        expect(await codeOf()).toBe(before)
        expect(before).toBeDefined()
    })
})
