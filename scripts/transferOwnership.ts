import { toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { transferOwnershipBody } from '../wrappers/Burner'
import { beginOwnerAction, confirm, printRequest } from '../wrappers/operate'

/**
 * Step one of two: nominate a new owner.
 *
 * Nothing changes hands here. The nominee has to run claimOwnership before they are in charge,
 * and until they do the current owner keeps every power they had. That is the whole point -- a
 * mistyped address costs a repeated nomination rather than the rescue hatch itself.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'nominate a new owner')
    if (session === null) {
        return
    }

    const newOwner = await ui.inputAddress('New owner address')

    if (newOwner.equals(session.sender)) {
        ui.write('That is already the owner. Nothing to do.')
        return
    }

    ui.write('')
    ui.write(`Nominating ${newOwner.toString()}.`)
    ui.write('They must then run: npx blueprint run claimOwnership')
    ui.write(`Until they do, ${session.sender.toString()} stays in control.`)
    if (session.pendingOwner) {
        ui.write('')
        ui.write(`This replaces the existing nomination of ${session.pendingOwner.toString()}.`)
    }
    ui.write('')

    const request = { value: toNano('0.05'), newOwner }
    printRequest(provider, {
        to: session.burner.address,
        value: request.value,
        body: transferOwnershipBody(request),
        note: `nominate ${newOwner.toString()} as owner (they must then claim)`,
    })

    if (!(await confirm(provider, 'Send the nomination?'))) {
        return
    }
    await session.burner.sendTransferOwnership(provider.sender(), request)
    ui.write('Sent. Confirm with: npx blueprint run showBurner')
}
