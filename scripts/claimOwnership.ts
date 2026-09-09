import { toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { claimOwnershipBody } from '../wrappers/Burner'
import { beginOwnerAction, confirm, printRequest } from '../wrappers/operate'

/**
 * Step two of two: take ownership you have been nominated for.
 *
 * Run from the nominated wallet, not the current owner's -- so this is the one owner script that
 * does not require the connected wallet to already be the owner.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'claim ownership', { requireOwner: false })
    if (session === null) {
        return
    }

    if (session.pendingOwner === null) {
        ui.write('REFUSING: nobody is nominated, so there is nothing to claim.')
        ui.write('The current owner must run transferOwnership first.')
        return
    }

    if (!session.pendingOwner.equals(session.sender)) {
        ui.write('REFUSING: the connected wallet is not the nominee, so this would only bounce.')
        ui.write(`Nominated: ${session.pendingOwner.toString()}`)
        ui.write(`Connected: ${session.sender.toString()}`)
        return
    }

    ui.write(`Taking ownership from ${session.owner?.toString() ?? 'nobody'}.`)
    ui.write('')

    printRequest(provider, {
        to: session.burner.address,
        value: toNano('0.05'),
        body: claimOwnershipBody(),
        note: 'claim ownership as the nominated address',
    })

    if (!(await confirm(provider, 'Claim ownership?'))) {
        return
    }
    await session.burner.sendClaimOwnership(provider.sender(), toNano('0.05'))
    ui.write('Sent. Confirm with: npx blueprint run showBurner')
}
