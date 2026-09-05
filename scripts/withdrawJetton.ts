import { Address, SendMode, fromNano, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { HGRAM, HPO } from '../wrappers/addresses'
import { beginOwnerAction, confirm, jettonBalance, walletAddressOf } from '../wrappers/operate'
import { jettonTransfer } from '../wrappers/rescue'

/**
 * Move any jetton out of the burner: hGRAM, HPO, or something that did not exist when this was
 * written.
 *
 * The burner only knows its own hGRAM and HPO wallets. For anything else the wallet address is
 * found here, off chain, by asking that jetton's master -- which is why "anything else" works at
 * all without the contract having to know about it.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'withdraw jettons')
    if (session === null) {
        return
    }

    const which = await ui.choose('Which jetton?', ['hGRAM', 'HPO', 'another jetton'], (c) => c)
    let master: Address
    let label: string
    if (which === 'hGRAM') {
        master = HGRAM
        label = 'hGRAM'
    } else if (which === 'HPO') {
        master = HPO
        label = 'HPO'
    } else {
        master = await ui.inputAddress('Jetton master address')
        label = 'jettons'
    }

    ui.write(`Asking ${master.toString()} where the burner's wallet is...`)
    const wallet = await walletAddressOf(provider, master, session.burner.address)
    const held = await jettonBalance(provider, wallet)

    ui.write(`  wallet   ${wallet.toString()}`)
    ui.write(`  balance  ${fromNano(held)} ${label}`)
    ui.write('')

    if (held === 0n) {
        ui.write(`The burner holds no ${label}. Nothing to withdraw.`)
        ui.write('If you expected some, it may still be mid-cycle -- check showBurner again shortly.')
        return
    }

    const destination = await ui.inputAddress(`Send the ${label} to`, session.sender)

    const how = await ui.choose('How much?', ['everything', 'a specific amount'], (c) => c)
    let amount = held
    if (how === 'a specific amount') {
        const raw = await ui.input(`Amount in ${label} (holding ${fromNano(held)})`)
        amount = toNano(raw.trim())
        if (amount <= 0n || amount > held) {
            ui.write(`Amount must be between 0 and ${fromNano(held)}. Aborted.`)
            return
        }
    }

    ui.write('')
    ui.write(`About to move ${fromNano(amount)} ${label} to ${destination.toString()}.`)
    if (which === 'HPO') {
        ui.write('')
        ui.write('NOTE: this takes HPO out instead of burning it. In a working cycle HPO is burned')
        ui.write('within a block of arriving, so only do this if it is genuinely stuck.')
    }
    ui.write('')
    if (!(await confirm(provider, 'Send it?'))) {
        return
    }

    // 0.2 GRAM covers the wallet's own fees; the remainder returns to the destination.
    await session.burner.sendWithdraw(provider.sender(), {
        value: toNano('0.3'),
        mode: SendMode.PAY_GAS_SEPARATELY,
        message: jettonTransfer(wallet, {
            to: destination,
            responseTo: destination,
            amount,
            attached: toNano('0.2'),
        }),
    })

    ui.write('Sent.')
    ui.write('')
    ui.write('If those tokens were stuck rather than in flight, follow this with:')
    ui.write('  npx blueprint run resetPending')
    ui.write('Otherwise the contract still believes they are here and will keep retrying that leg.')
}
