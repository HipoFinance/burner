import { Cell, Slice, toNano } from '@ton/core'
import { compile } from '@ton/blueprint'
import { readFileSync } from 'fs'

import { errAccessDenied } from '../wrappers/Burner'
import { dryRunUpgrade, formatDryRun } from '../wrappers/upgradeDryRun'
import { Fixture, setup } from './helper'

const BORROWER_FEE = toNano('22.9')

/** The id run_migrator enters a migrator at, matching contracts/burner.fc. */
const migrateMethodId = 0x6d67

/** What contracts/mock/migrators/mark.fc writes over total_received. */
const MARKER = 424242424242n

describe('Upgrades', () => {
    let v2: Cell
    let markMigrator: Cell
    let unparseableMigrator: Cell
    let dropOwnerMigrator: Cell
    let failingMigrator: Cell
    let notABurner: Cell

    beforeAll(async () => {
        v2 = await compile('BurnerV2')
        markMigrator = await compile('MigrateMark')
        unparseableMigrator = await compile('MigrateUnparseable')
        dropOwnerMigrator = await compile('MigrateDropOwner')
        failingMigrator = await compile('MigrateFailing')
        // Any real contract that is not a burner. Used as new_code to prove that installing
        // something that cannot answer upgrade_data reverts rather than bricking the burner.
        notABurner = await compile('MockHipoTreasury')
    })

    const codeHashOf = async (f: Fixture): Promise<string | undefined> => {
        const state = (await f.blockchain.getContract(f.burner.address)).account.account?.storage.state
        return state?.type === 'active' ? state.state.code?.hash().toString('hex') : undefined
    }

    const versionOf = async (f: Fixture): Promise<number | null> => {
        try {
            const { stack } = await f.blockchain
                .provider(f.burner.address)
                .get('get_version', [])
            return stack.readNumber()
        } catch {
            return null
        }
    }

    describe('installing new code', () => {
        it('replaces the code and keeps every counter, then keeps burning', async () => {
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)

            const before = await f.burner.getBurnerData()
            const progressBefore = await f.burner.getProgress()
            const codeBefore = await codeHashOf(f)
            expect(await versionOf(f)).toBeNull()

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                returnExcess: f.owner.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                success: true,
            })
            expect(await codeHashOf(f)).not.toBe(codeBefore)
            expect(await codeHashOf(f)).toBe(v2.hash().toString('hex'))
            expect(await versionOf(f)).toBe(2)

            // Storage survived the code swap untouched: the wallets it discovered, the hatch, and
            // every counter. Losing any of these would mean re-discovery or a stranded balance.
            const after = await f.burner.getBurnerData()
            expect(after.hgramWallet?.toString()).toBe(before.hgramWallet?.toString())
            expect(after.hpoWallet?.toString()).toBe(before.hpoWallet?.toString())
            expect(after.totalReceived).toBe(before.totalReceived)
            expect(after.totalDeposited).toBe(before.totalDeposited)
            expect(after.totalSwapped).toBe(before.totalSwapped)
            expect(after.totalBurned).toBe(before.totalBurned)
            expect((await f.burner.getOwnership()).owner?.toString()).toBe(f.owner.address.toString())

            // And it is still a burner. This is why the test upgrades to a real contract rather
            // than to a stub: a cycle has to run afterwards on the new code.
            const hpoBefore = await f.hpoSupply()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE, 1n)
            expect(await f.hpoSupply()).toBeLessThan(hpoBefore)

            const progressAfter = await f.burner.getProgress()
            expect(progressAfter.depositCount).toBe(progressBefore.depositCount + 1)
            expect(progressAfter.burnCount).toBe(progressBefore.burnCount + 1)
            expect(progressAfter.hgramPending).toBe(0n)
            expect(progressAfter.hpoPending).toBe(0n)
        })

        it('returns the leftover gas to where the message asked', async () => {
            const f: Fixture = await setup()

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                returnExcess: f.stranger.address,
            })

            expect(result.transactions).toHaveTransaction({
                from: f.burner.address,
                to: f.stranger.address,
                op: 0xd53276db, // op::gas_excess
                success: true,
            })
        })
    })

    describe('who may upgrade', () => {
        it('refuses anyone who is not the owner', async () => {
            const f: Fixture = await setup()
            const before = await codeHashOf(f)

            const result = await f.burner.sendUpgradeCode(f.stranger.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                returnExcess: f.stranger.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
                success: false,
            })
            expect(await codeHashOf(f)).toBe(before)
        })

        it('is closed for good by drop_ownership, along with the rescue hatch', async () => {
            const f: Fixture = await setup()
            const before = await codeHashOf(f)

            await f.burner.sendDropOwnership(f.owner.getSender(), toNano('0.1'))
            expect((await f.burner.getOwnership()).owner).toBeNull()

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                returnExcess: f.owner.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
                success: false,
            })
            expect(await codeHashOf(f)).toBe(before)
            expect(await versionOf(f)).toBeNull()
        })

        it('does not let a non-owner upgrade be counted as a payment', async () => {
            // Owner ops are handled before the payment branch. A refused upgrade must not have been
            // banked as income on the way to being refused.
            const f: Fixture = await setup()
            const before = await f.burner.getBurnerData()

            await f.burner.sendUpgradeCode(f.stranger.getSender(), {
                value: toNano('5'),
                newCode: v2,
                returnExcess: f.stranger.address,
            })

            expect((await f.burner.getBurnerData()).totalReceived).toBe(before.totalReceived)
        })
    })

    describe('migrations', () => {
        it('runs a migration that changes values without changing the layout', async () => {
            // The case that motivates "absent is the only way to say no migration": this storage
            // parses fine either way, so only the marker distinguishes "ran" from "silently dropped".
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            const before = await f.burner.getBurnerData()
            expect(before.totalReceived).not.toBe(MARKER)

            await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                migrateCode: markMigrator,
                returnExcess: f.owner.address,
            })

            expect(await versionOf(f)).toBe(2)
            const after = await f.burner.getBurnerData()
            expect(after.totalReceived).toBe(MARKER)
            // Only the marked field moved.
            expect(after.totalDeposited).toBe(before.totalDeposited)
            expect(after.totalBurned).toBe(before.totalBurned)
        })

        it('reverts whole when the migration leaves storage the new code cannot read', async () => {
            // The unrecoverable case if it were ever allowed to commit: recv_internal loads data
            // before it dispatches, so a burner with unparseable storage could not be upgraded again.
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            const before = await f.burner.getBurnerData()
            const codeBefore = await codeHashOf(f)

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                migrateCode: unparseableMigrator,
                returnExcess: f.owner.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                success: false,
            })
            expect(await codeHashOf(f)).toBe(codeBefore)
            expect(await versionOf(f)).toBeNull()
            expect((await f.burner.getBurnerData()).totalReceived).toBe(before.totalReceived)
        })

        it('reverts whole when the migration would leave nobody able to reach the contract', async () => {
            const f: Fixture = await setup()
            const codeBefore = await codeHashOf(f)

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                migrateCode: dropOwnerMigrator,
                returnExcess: f.owner.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                exitCode: errAccessDenied,
                success: false,
            })
            expect(await codeHashOf(f)).toBe(codeBefore)
            expect((await f.burner.getOwnership()).owner?.toString()).toBe(f.owner.address.toString())
        })

        it('reverts whole when the migration itself throws, and keeps burning', async () => {
            const f: Fixture = await setup()
            const codeBefore = await codeHashOf(f)

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: v2,
                migrateCode: failingMigrator,
                returnExcess: f.owner.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                success: false,
            })
            expect(await codeHashOf(f)).toBe(codeBefore)

            const hpoBefore = await f.hpoSupply()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            expect(await f.hpoSupply()).toBeLessThan(hpoBefore)
        })

        it('reverts whole when the new code cannot answer upgrade_data at all', async () => {
            const f: Fixture = await setup()
            const codeBefore = await codeHashOf(f)

            const result = await f.burner.sendUpgradeCode(f.owner.getSender(), {
                value: toNano('0.5'),
                newCode: notABurner,
                returnExcess: f.owner.address,
            })

            expect(result.transactions).toHaveTransaction({
                to: f.burner.address,
                success: false,
            })
            expect(await codeHashOf(f)).toBe(codeBefore)

            const hpoBefore = await f.hpoSupply()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            expect(await f.hpoSupply()).toBeLessThan(hpoBefore)
        })
    })

    // The rehearsal an operator actually approves the upgrade from. It is emergency-adjacent code,
    // so it is driven by the tests rather than trusted on the day.
    describe('the dry run', () => {
        const cellsOf = async (f: Fixture) => {
            const state = (await f.blockchain.getContract(f.burner.address)).account.account?.storage.state
            if (state?.type !== 'active' || state.state.code == null || state.state.data == null) {
                throw new Error('not active')
            }
            return { code: state.state.code, data: state.state.data }
        }

        it('reports a clean upgrade as code-only, with no field moving', async () => {
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            const { code, data } = await cellsOf(f)

            const result = await dryRunUpgrade({
                address: f.burner.address,
                currentCode: code,
                currentData: data,
                newCode: v2,
                owner: f.owner.address,
            })

            expect(result.ok).toBe(true)
            expect(result.changes).toEqual([])
            expect(result.after?.codeHash).toBe(v2.hash().toString('hex'))
            expect(formatDryRun(result)).toContain('no field changed')
        })

        it('itemises exactly the field a migration moves', async () => {
            const f: Fixture = await setup()
            await f.burner.sendBorrowerFee(f.treasury.getSender(), BORROWER_FEE)
            const { code, data } = await cellsOf(f)

            const result = await dryRunUpgrade({
                address: f.burner.address,
                currentCode: code,
                currentData: data,
                newCode: v2,
                migrateCode: markMigrator,
                owner: f.owner.address,
            })

            expect(result.ok).toBe(true)
            expect(result.changes.map((c) => c.field)).toEqual(['total_received'])
            expect(result.changes[0].after).toBe(String(MARKER))
            expect(formatDryRun(result)).toContain('1 field(s) would change')
        })

        it('refuses an upgrade that would fail, before anything is signed', async () => {
            const f: Fixture = await setup()
            const { code, data } = await cellsOf(f)

            for (const bad of [unparseableMigrator, dropOwnerMigrator, failingMigrator]) {
                const result = await dryRunUpgrade({
                    address: f.burner.address,
                    currentCode: code,
                    currentData: data,
                    newCode: v2,
                    migrateCode: bad,
                    owner: f.owner.address,
                })
                expect(result.ok).toBe(false)
                expect(formatDryRun(result)).toContain('Do not send this upgrade')
            }
        })

        it('shows a route change as a diff line, not as something to find in a review', async () => {
            // The most consequential thing an upgrade here can do is repoint the burn. The route is
            // compile-time, so it never appears in a storage diff -- which is exactly why the dry
            // run reads it back out of the installed code and compares it too.
            const f: Fixture = await setup()
            const { code, data } = await cellsOf(f)

            const result = await dryRunUpgrade({
                address: f.burner.address,
                currentCode: code,
                currentData: data,
                newCode: v2,
                owner: f.owner.address,
            })

            expect(result.before.fields.map((x) => x[0])).toContain('route: pool')
            expect(result.after?.fields.map((x) => x[0])).toContain('route: pool')
        })
    })

    // Mechanical guardrails on migrators themselves. A migrator runs with the burner's full
    // authority, and the three things it must not do are each a single opcode or a compilation
    // shape, so none of them is left to review discipline.
    describe('the rules a migrator must obey', () => {
        // Walks the method dictionary out of a compiled contract. FunC puts the id -> procedure
        // hashmap in the first ref of the code cell, keyed by signed 19-bit ids. The values are
        // inline slices rather than refs, so the generic Dictionary parser cannot read it and only
        // the keys are recovered here.
        function methodIds(code: Cell, keyLen = 19): number[] {
            const out: number[] = []
            if (code.refs.length === 0) return out

            const walk = (slice: Slice, left: number, prefix: string) => {
                let label = ''
                const long = slice.loadBit()
                if (!long) {
                    // hml_short: unary length, then that many bits
                    let n = 0
                    while (slice.loadBit()) n++
                    for (let i = 0; i < n; i++) label += slice.loadBit() ? '1' : '0'
                } else {
                    const same = slice.loadBit()
                    const width = Math.ceil(Math.log2(left + 1))
                    if (!same) {
                        // hml_long: a counted run of bits
                        const n = slice.loadUint(width)
                        for (let i = 0; i < n; i++) label += slice.loadBit() ? '1' : '0'
                    } else {
                        // hml_same: one bit repeated
                        const bit = slice.loadBit() ? '1' : '0'
                        label = bit.repeat(slice.loadUint(width))
                    }
                }
                const rest = left - label.length
                if (rest === 0) {
                    const bits = prefix + label
                    let value = parseInt(bits, 2)
                    if (bits.startsWith('1')) value -= 1 << bits.length // ids are signed
                    out.push(value)
                } else {
                    walk(slice.loadRef().beginParse(), rest - 1, prefix + label + '0')
                    walk(slice.loadRef().beginParse(), rest - 1, prefix + label + '1')
                }
            }
            walk(code.refs[0].beginParse(), keyLen, '')
            return out.sort((a, b) => a - b)
        }

        it('keeps upgrade_data reachable by CALLDICT, in both the old code and the new', async () => {
            // The mechanism turns on this. upgrade_code calls upgrade_data after set_c3, so the
            // call has to go through the method dictionary to land in the code being installed.
            // Marking upgrade_data `inline` would compile it away into the caller, silently
            // reverting the upgrade to whatever the OLD code does -- with nothing else failing.
            //
            // 88277 is (crc16("upgrade_data") & 0xffff) | 0x10000, the id FunC derives from the
            // name; it is asserted as a literal so that renaming the function is a visible break.
            const upgradeDataId = 88277
            for (const code of [await compile('Burner'), v2]) {
                const ids = methodIds(code)
                expect(ids).toContain(0)
                expect(ids).toContain(upgradeDataId)
                // Everything else in the burner is inlined, so the dictionary holds only the entry
                // point and the name-derived methods at (crc16(name) & 0xffff) | 0x10000.
                expect(ids.filter((id) => id !== 0 && id < 65536)).toEqual([])
                // 0x6d67 sits below that band, which is why a migrator's entry point can never
                // collide with a method the burner already has.
                expect(ids).not.toContain(migrateMethodId)
            }
        })

        it.each([
            ['mark', () => markMigrator],
            ['unparseable', () => unparseableMigrator],
            ['drop_owner', () => dropOwnerMigrator],
            ['failing', () => failingMigrator],
        ])('compiles %s to exactly the entry point and nothing else', (_name, code) => {
            // EXECUTE does not set c3, so c3 still holds the BURNER's code while a migrator runs. A
            // non-inlined function in a migrator compiles to CALLDICT and would dispatch into the
            // burner's own dictionary, silently running a burner internal with wrong arguments.
            // Exactly two ids means everything is inlined and that cannot happen.
            expect(methodIds(code())).toEqual([0, migrateMethodId])
        })

        it.each(['mark', 'unparseable', 'drop_owner', 'failing'])(
            'compiles %s without commit() or set_code()',
            (name) => {
                // commit() locks in c4 and the set_code action upgrade_code already queued, which
                // makes every check after the migration decorative -- and a migrator that commits
                // and then writes an unparseable cell is unrecoverable.
                //
                // set_code() is appended after the one upgrade_code queued, and the last action
                // wins, so a migrator could install code the upgrade message never named.
                const source = readFileSync(`${__dirname}/../contracts/mock/migrators/${name}.fc`, 'utf8')
                // Comments are stripped first, or the explanation of this very rule would trip it.
                const code = source.replace(/;;.*$/gm, '')
                expect(code).not.toMatch(/\bcommit\s*\(/)
                expect(code).not.toMatch(/\bset_code\s*\(/)
            },
        )
    })
})
