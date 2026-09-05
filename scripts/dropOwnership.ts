import { toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { beginOwnerAction, confirm, gram, jettonBalance } from '../wrappers/operate'

/**
 * Give up the rescue hatch, permanently.
 *
 * After this the burner is exactly what it claims to be: a mechanism nobody can reach into. The
 * burn stops being trusted and starts being mechanical, which is the point of doing it -- but
 * there is no path back, and anything left inside is left there for good.
 *
 * So this script checks what would be abandoned before it lets you.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'DROP OWNERSHIP -- irreversible')
    if (session === null) {
        return
    }

    const data = await session.burner.getBurnerData()

    ui.write('After this, nobody can withdraw from this contract, ever. Check what is inside:')
    ui.write('')
    ui.write(`  GRAM balance   ${gram(session.balance)}`)

    let stranded = false
    if (data.hgramWallet) {
        const held = await jettonBalance(provider, data.hgramWallet)
        ui.write(`  hGRAM held     ${held.toString()}`)
        stranded ||= held > 0n
    }
    if (data.hpoWallet) {
        const held = await jettonBalance(provider, data.hpoWallet)
        ui.write(`  HPO held       ${held.toString()}`)
        stranded ||= held > 0n
    }
    ui.write(`  pending        ${session.hgramPending.toString()} hGRAM, ${session.hpoPending.toString()} HPO`)
    ui.write('')

    if (stranded) {
        ui.write('WARNING: tokens are sitting in the burner right now. In a healthy cycle they')
        ui.write('clear within a few blocks, so this may just be a snapshot mid-cycle -- but if')
        ui.write('they are stuck, dropping ownership abandons them permanently.')
        ui.write('Re-run showBurner in a minute and check they cleared before continuing.')
        ui.write('')
    }

    ui.write('This cannot be undone. There is no recovery, no redeploy that reclaims these funds,')
    ui.write('and no governance action that restores access.')
    ui.write('')

    if (!(await confirm(provider, 'Permanently drop ownership?'))) {
        return
    }
    const typed = await ui.input(`Type the burner address to confirm (${session.burner.address.toString()})`)
    if (typed.trim() !== session.burner.address.toString()) {
        ui.write('Address did not match. Aborted. Nothing was sent.')
        return
    }

    await session.burner.sendDropOwnership(provider.sender(), toNano('0.05'))
    ui.write('Sent. The burner is now immutable. Confirm with: npx blueprint run showBurner')
}
