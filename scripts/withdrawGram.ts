import { SendMode, fromNano, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { beginOwnerAction, confirm, gram } from '../wrappers/operate'
import { gramTransfer } from '../wrappers/rescue'

/**
 * Move GRAM out of the burner.
 *
 * Two shapes, because they fail differently. Taking an amount leaves the contract funded and
 * running; taking everything stops it dead -- with no balance it cannot pay storage, and it will
 * eventually be frozen. The second is what you want when abandoning a burner, and a mistake
 * otherwise, so the script makes you say which.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'withdraw GRAM')
    if (session === null) {
        return
    }

    if (session.balance === 0n) {
        ui.write('The burner has no GRAM. Nothing to withdraw.')
        return
    }

    const destination = await ui.inputAddress('Send the GRAM to', session.sender)

    const how = await ui.choose(
        'How much?',
        ['a specific amount', 'everything, and stop the contract'],
        (c) => c,
    )

    let message
    let describe: string
    if (how === 'a specific amount') {
        const raw = await ui.input(`Amount in GRAM (balance is ${fromNano(session.balance)})`)
        const amount = toNano(raw.trim())
        if (amount <= 0n) {
            ui.write('Amount must be positive. Aborted.')
            return
        }
        // Leave enough behind that the contract can still run a cycle: the reserve funds the swap
        // and burn legs of anything already in flight.
        if (session.balance - amount < toNano('1')) {
            ui.write('')
            ui.write('WARNING: this leaves under 1 GRAM, which is the reserve the contract needs to')
            ui.write('finish a cycle already in flight. Legs may stall until it is topped up.')
            ui.write('')
        }
        message = gramTransfer(destination, amount)
        describe = `${gram(amount)} to ${destination.toString()}`
    } else {
        ui.write('')
        ui.write('This sends the entire balance and leaves nothing for storage. The account will')
        ui.write('be frozen in time, and any later payment to it may be lost. Only do this when')
        ui.write('abandoning this burner for good.')
        ui.write('')
        message = gramTransfer(destination, 0n)
        describe = `the entire ${gram(session.balance)} to ${destination.toString()}`
    }

    ui.write(`About to send ${describe}.`)
    ui.write('')
    if (!(await confirm(provider, 'Send it?'))) {
        return
    }

    await session.burner.sendWithdraw(provider.sender(), {
        value: toNano('0.05'),
        mode:
            how === 'a specific amount'
                ? SendMode.PAY_GAS_SEPARATELY
                : SendMode.CARRY_ALL_REMAINING_BALANCE,
        message,
    })
    ui.write('Sent. Confirm with: npx blueprint run showBurner')
}
