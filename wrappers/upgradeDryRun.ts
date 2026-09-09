import { Address, Cell, toNano } from '@ton/core'
import { Blockchain, SandboxContract, createShardAccount } from '@ton/sandbox'

import { Burner } from './Burner'

/**
 * Rehearses an upgrade against the burner's real account inside a local sandbox, so an operator can
 * see what a migration actually does to live state before signing anything.
 *
 * Deliberately generic rather than written around any one migration: it snapshots everything the
 * burner exposes, runs the upgrade, snapshots again, and reports every field that moved. A
 * migration that changes something nobody intended shows up as a line in the diff rather than as a
 * discovery afterwards -- which matters more here than it would elsewhere, because the wrong
 * storage write is the one failure this contract cannot be talked out of.
 */

export interface Snapshot {
    codeHash: string
    dataHash: string
    dataBits: number
    dataRefs: number
    fields: [string, string][]
}

export interface FieldChange {
    field: string
    before: string
    after: string
}

export interface DryRunResult {
    ok: boolean
    /** Why the upgrade would fail, when ok is false. */
    failure?: string
    exitCode?: number
    before: Snapshot
    after?: Snapshot
    changes: FieldChange[]
}

/**
 * Reads everything the burner exposes. Ordered, so two snapshots line up positionally and a field
 * appearing or disappearing between code versions is itself visible.
 */
async function snapshot(burner: SandboxContract<Burner>, code: Cell, data: Cell): Promise<Snapshot> {
    const shell = {
        codeHash: code.hash().toString('hex'),
        dataHash: data.hash().toString('hex'),
        dataBits: data.bits.length,
        dataRefs: data.refs.length,
    }

    // An upgrade that changes the shape of a getter makes this wrapper unable to read the side of
    // the upgrade it was not built for -- and that is precisely the upgrade most worth rehearsing.
    // Report what is still knowable from the raw cells rather than throwing, so the run reaches a
    // verdict; it is the field-by-field diff that degrades, not the pass/fail.
    try {
        const data_ = await burner.getBurnerData()
        const ownership = await burner.getOwnership()
        const progress = await burner.getProgress()
        const route = await burner.getRoute()

        const fields: [string, string][] = [
            ['hgram_wallet', data_.hgramWallet?.toString() ?? 'not discovered'],
            ['hpo_wallet', data_.hpoWallet?.toString() ?? 'not discovered'],
            ['owner', ownership.owner?.toString() ?? 'none -- dropped'],
            ['pending_owner', ownership.pendingOwner?.toString() ?? 'none'],
            ['total_received', String(data_.totalReceived)],
            ['total_deposited', String(data_.totalDeposited)],
            ['total_swapped', String(data_.totalSwapped)],
            ['total_burned', String(data_.totalBurned)],
            ['hgram_pending', String(progress.hgramPending)],
            ['hpo_pending', String(progress.hpoPending)],
            ['deposit_count', String(progress.depositCount)],
            ['swap_count', String(progress.swapCount)],
            ['burn_count', String(progress.burnCount)],
            ['query_id', String(progress.queryId)],
            // Not storage -- these are compile-time constants in the code being installed. A route
            // that moves is the single most consequential thing an upgrade can do here, so it is
            // diffed alongside the state rather than left to a code review.
            ['route: treasury', route.treasury.toString()],
            ['route: parent', route.parent.toString()],
            ['route: hgram vault', route.dedustHgramVault.toString()],
            ['route: pool', route.dedustPool.toString()],
        ]
        return { ...shell, fields }
    } catch {
        return { ...shell, fields: [['state', 'not readable by this wrapper (getter shapes differ)']] }
    }
}

async function accountCells(blockchain: Blockchain, address: Address): Promise<{ code: Cell; data: Cell }> {
    const contract = await blockchain.getContract(address)
    const state = contract.account.account?.storage.state
    if (state?.type !== 'active' || state.state.code == null || state.state.data == null) {
        throw new Error('burner account is not active in the sandbox')
    }
    return { code: state.state.code, data: state.state.data }
}

export async function dryRunUpgrade(opts: {
    address: Address
    currentCode: Cell
    currentData: Cell
    newCode: Cell
    migrateCode?: Cell
    owner: Address
}): Promise<DryRunResult> {
    const blockchain = await Blockchain.create()
    await blockchain.setShardAccount(
        opts.address,
        createShardAccount({
            workchain: opts.address.workChain,
            address: opts.address,
            code: opts.currentCode,
            data: opts.currentData,
            balance: toNano('100'),
        }),
    )
    const burner = blockchain.openContract(Burner.createFromAddress(opts.address))

    const before = await snapshot(burner, opts.currentCode, opts.currentData)

    const result = await burner.sendUpgradeCode(blockchain.sender(opts.owner), {
        value: toNano('1'),
        newCode: opts.newCode,
        migrateCode: opts.migrateCode,
        returnExcess: opts.owner,
    })

    // Only the burner's own transaction is judged. The gas_excess refund is addressed to the real
    // owner, which does not exist as an account in this sandbox, so it lands uninitialised and
    // reports as aborted -- an artifact of replaying mainnet state locally, not a real failure.
    const own = result.transactions.filter((t) => t.inMessage?.info.dest?.toString() === opts.address.toString())
    for (const tx of own) {
        if (tx.description.type !== 'generic') continue
        const compute = tx.description.computePhase
        if (compute.type === 'skipped') {
            return { ok: false, failure: `compute phase skipped: ${compute.reason}`, before, changes: [] }
        }
        if (!compute.success) {
            return {
                ok: false,
                failure: `upgrade would FAIL with exit code ${String(compute.exitCode)}`,
                exitCode: compute.exitCode,
                before,
                changes: [],
            }
        }
        if (tx.description.actionPhase != null && !tx.description.actionPhase.success) {
            return {
                ok: false,
                failure: `action phase would fail with code ${String(tx.description.actionPhase.resultCode)}`,
                before,
                changes: [],
            }
        }
    }

    const cells = await accountCells(blockchain, opts.address)
    const after = await snapshot(burner, cells.code, cells.data)

    const changes: FieldChange[] = []
    for (let i = 0; i < before.fields.length; i++) {
        const [field, wasValue] = before.fields[i]
        const nowValue = after.fields[i]?.[1] ?? '(missing)'
        if (wasValue !== nowValue) changes.push({ field, before: wasValue, after: nowValue })
    }

    return { ok: true, before, after, changes }
}

/**
 * Renders the result for a terminal. Kept out of the script so the script stays about the upgrade
 * flow and this stays testable on its own.
 */
export function formatDryRun(result: DryRunResult): string {
    const rule = '='.repeat(80)
    const lines: string[] = [rule, 'DRY RUN -- this upgrade replayed against the live account in a local sandbox', rule]

    if (!result.ok) {
        lines.push('')
        lines.push(`  RESULT: ${result.failure ?? 'unknown failure'}`)
        lines.push('')
        lines.push('  Nothing would change on chain: the burner would stay on its current code with')
        lines.push('  its current data. Do not send this upgrade.')
        lines.push(rule)
        return lines.join('\n')
    }

    const after = result.after
    if (after == null) return lines.join('\n')

    const move = (was: string, now: string) => `${was} -> ${now}`

    lines.push('')
    lines.push(`  code hash   ${move(result.before.codeHash.slice(0, 16), after.codeHash.slice(0, 16))}`)
    lines.push(`  data hash   ${move(result.before.dataHash.slice(0, 16), after.dataHash.slice(0, 16))}`)
    lines.push(
        '  data size   ' +
            move(
                `${String(result.before.dataBits)} bits / ${String(result.before.dataRefs)} refs`,
                `${String(after.dataBits)} bits / ${String(after.dataRefs)} refs`,
            ),
    )
    lines.push('')

    // An empty change list means two very different things, and an operator must not have to guess
    // which. Say so explicitly when the state could not be itemised at all.
    const unreadable = (s: Snapshot) => s.fields.length === 1 && s.fields[0][0] === 'state'
    if (unreadable(result.before) || unreadable(after)) {
        lines.push('  STATE DIFF: not readable across this upgrade.')
        lines.push('  A getter changes shape here, so fields cannot be compared. The hashes above')
        lines.push('  still hold. Verify this one by reading the migrator.')
    } else if (result.changes.length === 0) {
        lines.push('  STATE DIFF: no field changed. This upgrade replaces code only.')
    } else {
        lines.push(`  STATE DIFF: ${String(result.changes.length)} field(s) would change.`)
        lines.push('  Read every line. Anything here that you did not intend is a reason to stop.')
        lines.push('')
        const width = Math.max(...result.changes.map((ch) => ch.field.length))
        for (const change of result.changes) {
            lines.push(`    ${change.field.padEnd(width)}  - ${change.before}`)
            lines.push(`    ${' '.repeat(width)}  + ${change.after}`)
        }
    }

    lines.push(rule)
    return lines.join('\n')
}
