import { Cell, toNano } from '@ton/core'
import { NetworkProvider, compile } from '@ton/blueprint'
import { readFileSync } from 'fs'

import { beginOwnerAction, confirm } from '../wrappers/operate'
import { dryRunUpgrade, formatDryRun } from '../wrappers/upgradeDryRun'

/**
 * Install new code on the deployed burner.
 *
 * The contract was immutable in its first deployment and is not any more, for one reason: the
 * address is the identity, referenced from the DefiLlama adapters and anything else that tracks the
 * burn. That trade is only defensible if an upgrade is hard to get wrong, so this script does the
 * work that makes it hard to get wrong:
 *
 *   - it reads the burner's ACTUAL code and storage off the network and replays the whole upgrade
 *     in a local sandbox, then prints a field-level diff of what would change. So the operator
 *     approves observed behaviour on real state, not a description of intent;
 *   - it prints the migrator source in full and demands its hash typed back, because a migrator is
 *     code that runs with the burner's full authority and is not part of the reviewed code release;
 *   - it refuses locally when the connected wallet is not the owner, rather than bouncing.
 *
 * See docs/runbook.md.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'UPGRADE CODE')
    if (session === null) {
        return
    }

    // The code being installed. Built from this working tree, so what is reviewed is what is sent.
    const newCode = await compile('Burner')

    const state = await provider.provider(session.burner.address).getState()
    if (state.state.type !== 'active') {
        ui.write('The burner account is not active. Aborting.')
        return
    }
    const currentCode = Cell.fromBoc(state.state.code ?? Buffer.alloc(0))[0]
    const currentData = Cell.fromBoc(state.state.data ?? Buffer.alloc(0))[0]

    if (currentCode.hash().equals(newCode.hash())) {
        ui.write('The burner is already running this exact code. Nothing to do.')
        return
    }

    // The migration, if this upgrade needs one. Absent is the only way to say "no migration": an
    // empty cell is not a second way of saying it, and would be run and throw.
    let migrateCode: Cell | undefined
    let migratorPath: string | undefined
    const wantsMigration = await ui.choose(
        'Does this upgrade change the storage layout, or need a one-off migration?',
        ['no -- code only', 'yes -- run a migrator'],
        (c) => c,
    )
    if (wantsMigration.startsWith('yes')) {
        const name = await ui.input('Migrator wrapper name (e.g. MigrateMark, from wrappers/<name>.compile.ts)')
        migrateCode = await compile(name.trim())
        migratorPath = await ui.input('Path to the migrator source, for review (contracts/mock/migrators/....fc)')
    }

    // ---------------------------------------------------------------------------------------------
    // The dry run, against the real account.
    // ---------------------------------------------------------------------------------------------

    ui.write('')
    ui.write('Replaying the upgrade against the live account in a sandbox...')
    const result = await dryRunUpgrade({
        address: session.burner.address,
        currentCode,
        currentData,
        newCode,
        migrateCode,
        owner: session.sender,
    })

    ui.write('')
    ui.write(formatDryRun(result))
    ui.write('')

    if (!result.ok) {
        ui.write('Aborted. Nothing was sent.')
        return
    }

    // ---------------------------------------------------------------------------------------------
    // The migrator review. A migrator is code, and it is not part of the reviewed code release.
    // ---------------------------------------------------------------------------------------------

    if (migrateCode !== undefined) {
        ui.write('The migrator runs once, inside the upgrade transaction, with the burner\'s full')
        ui.write('authority. It is not part of the published code hash. Read it:')
        ui.write('')
        if (migratorPath !== undefined && migratorPath.trim() !== '') {
            try {
                ui.write(readFileSync(migratorPath.trim(), 'utf8'))
            } catch {
                ui.write(`(could not read ${migratorPath.trim()} -- read it yourself before continuing)`)
            }
        }
        ui.write('')
        const migratorHash = migrateCode.hash().toString('hex')
        ui.write(`Migrator code hash: ${migratorHash}`)
        const typed = await ui.input('Type the migrator hash to confirm you have read it')
        if (typed.trim() !== migratorHash) {
            ui.write('Hash did not match. Aborted. Nothing was sent.')
            return
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Send.
    // ---------------------------------------------------------------------------------------------

    ui.write('')
    ui.write(`Burner       ${session.burner.address.toString()}`)
    ui.write(`New code     ${newCode.hash().toString('hex')}`)
    ui.write(`Migration    ${migrateCode === undefined ? 'none' : migrateCode.hash().toString('hex')}`)
    ui.write('')
    ui.write('If this fails on chain it reverts whole -- old code, old data -- so the risk is a')
    ui.write('wasted fee, not a broken burner. What the dry run cannot tell you is whether the new')
    ui.write('code is the code you meant to write.')
    ui.write('')

    if (!(await confirm(provider, 'Send this upgrade?'))) {
        return
    }
    const typedAddress = await ui.input(`Type the burner address to confirm (${session.burner.address.toString()})`)
    if (typedAddress.trim() !== session.burner.address.toString()) {
        ui.write('Address did not match. Aborted. Nothing was sent.')
        return
    }

    await session.burner.sendUpgradeCode(provider.sender(), {
        value: toNano('0.2'),
        newCode,
        migrateCode,
        returnExcess: session.sender,
    })
    ui.write('Sent. Confirm with: npx blueprint run showBurner')
}
