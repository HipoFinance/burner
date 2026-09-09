import { Address, SendMode, toNano } from '@ton/core'
import { flattenTransaction } from '@ton/test-utils'

import { errAccessDenied } from '../wrappers/Burner'
import { mockMode } from '../wrappers/MockDedust'
import { gramTransfer, jettonTransfer } from '../wrappers/rescue'
import { DEDUST_HGRAM_VAULT, Fixture, HIPO_TREASURY, HPO_MASTER, Op, mintHpoMessage, setup } from './helper'


const BORROWER_FEE = toNano('22.9')

describe('Ownership', () => {
    describe('the rescue hatch', () => {
        it('recovers GRAM the owner asks for', async () => {
            const f: Fixture = await setup()
            await f.burner.sendGram(f.stranger.getSender(), toNano('50'))

            const before = (await f.blockchain.getContract(f.burner.address)).balance
            expect(before).toBeGreaterThan(0n)

            const result = await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.1'),
                mode: SendMode.CARRY_ALL_REMAINING_BALANCE,
                message: gramTransfer(f.owner.address, 0n),
            })

            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: f.owner.address,
                success: true,
            })
            expect((await f.blockchain.getContract(f.burner.address)).balance).toBeLessThan(before)
        })

        it('recovers hGRAM stranded by a dead pool -- the case it exists for', async () => {
            // DeDust swallows the swap, so hGRAM ends up in our wallet with no way to spend it.
            const f: Fixture = await setup({ mode: mockMode.refund })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const stranded = await f.hgramBalance(f.burner.address)
            expect(stranded).toBeGreaterThan(0n)

            const result = await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.5'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: jettonTransfer(f.burnerHgramWallet, {
                    to: f.owner.address,
                    responseTo: f.owner.address,
                    amount: stranded,
                    attached: toNano('0.2'),
                }),
            })

            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: f.burnerHgramWallet,
                op: Op.sendTokens,
                success: true,
            })
            expect(await f.hgramBalance(f.burner.address)).toBe(0n)
            expect(await f.hgramBalance(f.owner.address)).toBe(stranded)
        })

        it('recovers HPO through the same builder the scripts use', async () => {
            // hGRAM goes through Hipo's wallet, HPO through a stock TEP-74 one. The scripts use a
            // single builder for both, so it is worth proving on both.
            const f: Fixture = await setup({ mode: mockMode.silent })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            // Put HPO in the burner's wallet directly, standing in for a burn that never landed.
            await f.deployer.send({
                to: HPO_MASTER,
                value: toNano('2'),
                body: mintHpoMessage(f.burner.address, toNano('1000'), toNano('1'), 0n),
            })
            const held = await f.hpoBalance(f.burner.address)
            expect(held).toBe(toNano('1000'))

            await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.5'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: jettonTransfer(f.burnerHpoWallet, {
                    to: f.owner.address,
                    responseTo: f.owner.address,
                    amount: held,
                    attached: toNano('0.2'),
                }),
            })

            expect(await f.hpoBalance(f.burner.address)).toBe(0n)
            expect(await f.hpoBalance(f.owner.address)).toBe(held)
        })

        it('recovers a partial amount, leaving the rest', async () => {
            const f: Fixture = await setup({ mode: mockMode.refund })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const stranded = await f.hgramBalance(f.burner.address)
            const half = stranded / 2n
            await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.5'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: jettonTransfer(f.burnerHgramWallet, {
                    to: f.owner.address,
                    responseTo: f.owner.address,
                    amount: half,
                    attached: toNano('0.2'),
                }),
            })

            expect(await f.hgramBalance(f.owner.address)).toBe(half)
            expect(await f.hgramBalance(f.burner.address)).toBe(stranded - half)
        })

        it('recovers a fixed amount of GRAM, leaving the contract running', async () => {
            const f: Fixture = await setup()
            await f.burner.sendGram(f.stranger.getSender(), toNano('50'))

            const before = (await f.blockchain.getContract(f.burner.address)).balance
            await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.05'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: gramTransfer(f.owner.address, toNano('0.3')),
            })

            // Gas moves the balance too, so assert the direction rather than an exact delta.
            expect((await f.blockchain.getContract(f.burner.address)).balance).toBeLessThan(before)
            // Still funded, and still able to run a cycle.
            const supplyBefore = await f.hpoSupply()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, 9n)
            expect(await f.hpoSupply()).toBeLessThan(supplyBefore)
        })

        it('squares the pending amounts after a withdrawal, so nothing retries forever', async () => {
            const f: Fixture = await setup({ mode: mockMode.refund })
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const stranded = await f.hgramBalance(f.burner.address)
            await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.5'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: jettonTransfer(f.burnerHgramWallet, {
                    to: f.owner.address,
                    responseTo: f.owner.address,
                    amount: stranded,
                    attached: toNano('0.2'),
                }),
            })

            // The books still claim the hGRAM is here, so a poke would retry a doomed leg.
            expect((await f.burner.getProgress()).hgramPending).toBeGreaterThan(0n)

            await f.burner.sendResetPending(f.owner.getSender(), {
                value: toNano('0.1'),
                hgramPending: 0n,
                hpoPending: 0n,
            })

            const progress = await f.burner.getProgress()
            expect(progress.hgramPending).toBe(0n)
            expect(progress.hpoPending).toBe(0n)

            // And a later payment starts a fresh deposit instead of retrying the stuck swap.
            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, 1n)
            const deposits = result.transactions
                .map(flattenTransaction)
                .filter((t) => t.to?.equals(HIPO_TREASURY) && t.op === Op.depositCoins)
            expect(deposits).toHaveLength(1)
        })

        it('cannot be used by anyone else', async () => {
            const f: Fixture = await setup()
            await f.burner.sendGram(f.stranger.getSender(), toNano('50'))

            for (const who of [f.stranger, f.deployer, f.treasury]) {
                const result = await f.burner.sendWithdraw(who.getSender(), {
                    value: toNano('0.1'),
                    mode: SendMode.CARRY_ALL_REMAINING_BALANCE,
                    message: gramTransfer(who.address, 0n),
                })
                expect(result.transactions).toHaveTransaction({
                    to: f.burner.address,
                    exitCode: errAccessDenied,
                })
            }
        })

        it('does not let an owner message be mistaken for a payment', async () => {
            const f: Fixture = await setup()
            const before = await f.burner.getBurnerData()

            const result = await f.burner.sendResetPending(f.owner.getSender(), {
                value: toNano('5'),
                hgramPending: 0n,
                hpoPending: 0n,
            })

            // No cycle started, and the GRAM it carried was not counted as income.
            const deposits = result.transactions
                .map(flattenTransaction)
                .filter((t) => t.to?.equals(HIPO_TREASURY) && t.op === Op.depositCoins)
            expect(deposits).toHaveLength(0)
            expect((await f.burner.getBurnerData()).totalReceived).toBe(before.totalReceived)
        })
    })

    describe('transferring ownership', () => {
        it('takes two steps, so a mistyped address cannot destroy the hatch', async () => {
            const f: Fixture = await setup()

            await f.burner.sendTransferOwnership(f.owner.getSender(), {
                value: toNano('0.1'),
                newOwner: f.stranger.address,
            })

            // Nominated, not yet in charge.
            let ownership = await f.burner.getOwnership()
            expect(ownership.owner?.toString()).toBe(f.owner.address.toString())
            expect(ownership.pendingOwner?.toString()).toBe(f.stranger.address.toString())

            // The old owner still works until the claim lands.
            await f.burner.sendResetPending(f.owner.getSender(), {
                value: toNano('0.1'),
                hgramPending: 0n,
                hpoPending: 0n,
            })

            await f.burner.sendClaimOwnership(f.stranger.getSender(), toNano('0.1'))

            ownership = await f.burner.getOwnership()
            expect(ownership.owner?.toString()).toBe(f.stranger.address.toString())
            expect(ownership.pendingOwner).toBeNull()
        })

        it('lets only the nominated address claim', async () => {
            const f: Fixture = await setup()
            await f.burner.sendTransferOwnership(f.owner.getSender(), {
                value: toNano('0.1'),
                newOwner: f.stranger.address,
            })

            const result = await f.burner.sendClaimOwnership(f.deployer.getSender(), toNano('0.1'))
            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
            })
            expect((await f.burner.getOwnership()).owner?.toString()).toBe(f.owner.address.toString())
        })

        it('leaves the old owner in charge if the nominee never claims', async () => {
            const f: Fixture = await setup()
            await f.burner.sendTransferOwnership(f.owner.getSender(), {
                value: toNano('0.1'),
                newOwner: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
            })
            expect((await f.burner.getOwnership()).owner?.toString()).toBe(f.owner.address.toString())
        })
    })

    describe('dropping ownership', () => {
        it('makes the contract permanently unreachable, with no way back', async () => {
            const f: Fixture = await setup()
            await f.burner.sendDropOwnership(f.owner.getSender(), toNano('0.1'))

            const ownership = await f.burner.getOwnership()
            expect(ownership.owner).toBeNull()
            expect(ownership.pendingOwner).toBeNull()

            // The former owner is now just another address.
            await f.burner.sendGram(f.stranger.getSender(), toNano('50'))
            const result = await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.1'),
                mode: SendMode.CARRY_ALL_REMAINING_BALANCE,
                message: gramTransfer(f.owner.address, 0n),
            })
            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
            })

            // And nobody can claim it back.
            const claim = await f.burner.sendClaimOwnership(f.owner.getSender(), toNano('0.1'))
            expect(claim.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
            })
        })

        it('clears a pending nomination too, so it cannot be claimed afterwards', async () => {
            const f: Fixture = await setup()
            await f.burner.sendTransferOwnership(f.owner.getSender(), {
                value: toNano('0.1'),
                newOwner: f.stranger.address,
            })
            await f.burner.sendDropOwnership(f.owner.getSender(), toNano('0.1'))

            const result = await f.burner.sendClaimOwnership(f.stranger.getSender(), toNano('0.1'))
            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
            })
            expect((await f.burner.getOwnership()).owner).toBeNull()
        })

        it('leaves the burn cycle working exactly as before', async () => {
            const f: Fixture = await setup()
            await f.burner.sendDropOwnership(f.owner.getSender(), toNano('0.1'))

            const supplyBefore = await f.hpoSupply()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            expect(await f.hpoSupply()).toBeLessThan(supplyBefore)
            const progress = await f.burner.getProgress()
            expect(progress.depositCount).toBe(1)
            expect(progress.burnCount).toBe(1)
        })
    })

    describe('what the owner cannot do', () => {
        it('cannot redirect the burn: the route is in the code, not in storage', async () => {
            const f: Fixture = await setup()
            const route = await f.burner.getRoute()

            await f.burner.sendResetPending(f.owner.getSender(), {
                value: toNano('1'),
                hgramPending: 12345n,
                hpoPending: 678n,
            })

            const after = await f.burner.getRoute()
            expect(after.dedustPool.toString()).toBe(route.dedustPool.toString())
            expect(after.dedustHgramVault.toString()).toBe(route.dedustHgramVault.toString())
            expect(after.treasury.toString()).toBe(route.treasury.toString())
        })

        it('cannot make a cycle send HPO anywhere but the burn', async () => {
            const f: Fixture = await setup()
            const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const toHpoWallet = result.transactions
                .map(flattenTransaction)
                .filter((t) => t.from?.equals(f.burner.address) && t.to?.equals(f.burnerHpoWallet))
            expect(toHpoWallet.every((t) => t.op === Op.burn)).toBe(true)
            expect(toHpoWallet.length).toBeGreaterThan(0)
        })

        // The burner became upgradable on 2026-09-09, so "the owner cannot change the code" is no
        // longer true of the contract. It is still true of the rescue hatch, and that is worth
        // keeping pinned: op::withdraw hands its payload to send_raw_message, which cannot install
        // code, so changing the code stays something an operator has to ask for by name with
        // op::upgrade_code -- and tests/Upgrade.spec.ts covers what that may and may not do.
        it('cannot change the code: only op::upgrade_code reaches set_code', async () => {
            const f: Fixture = await setup()
            const codeOf = async () => {
                const st = (await f.blockchain.getContract(f.burner.address)).account.account?.storage.state
                return st?.type === 'active' ? st.state.code?.hash().toString('hex') : undefined
            }
            const before = await codeOf()

            await f.burner.sendWithdraw(f.owner.getSender(), {
                value: toNano('0.1'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: gramTransfer(f.owner.address, toNano('0.01')),
            })

            expect(await codeOf()).toBe(before)
            expect(before).toBeDefined()
        })
    })

    it('keeps the vault as the only hGRAM destination during a normal cycle', async () => {
        const f: Fixture = await setup()
        const result = await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

        const sends = result.transactions
            .map(flattenTransaction)
            .filter((t) => t.from?.equals(f.burner.address) && t.op === Op.sendTokens)
        expect(sends).toHaveLength(1)
        const body = sends[0]?.body?.beginParse()
        body?.loadUint(32)
        body?.loadUint(64)
        body?.loadCoins()
        expect(body?.loadAddress().toString()).toBe(DEDUST_HGRAM_VAULT.toString())
    })
})
