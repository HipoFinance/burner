import { Address, fromNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import type { OpenedContract } from '@ton/core'

import { BURNER } from './addresses'
import { Burner } from './Burner'

/**
 * Shared preamble for the owner scripts.
 *
 * These are run rarely and, by design, at the worst possible moment. So each one opens the same
 * way: find the contract, print what is actually true right now, and refuse locally if the
 * connected wallet is not the owner -- rather than sending a message that bounces and leaving the
 * operator to work out why from a hash.
 */

export const gram = (v: bigint) => `${fromNano(v)} GRAM`

export interface Session {
    burner: OpenedContract<Burner>
    owner: Address | null
    pendingOwner: Address | null
    /** The connected wallet. */
    sender: Address
    balance: bigint
    hgramPending: bigint
    hpoPending: bigint
}

/**
 * Open the burner, defaulting to the deployed one and allowing any other address to be given.
 *
 * The address is never derived here. A derivation is built from the contract's initial state,
 * which includes the original owner, so it stops reproducing the right address as soon as
 * ownership moves -- and it would do so silently, offering a plausible-looking default for a
 * contract that does not exist.
 */
export async function openBurner(provider: NetworkProvider): Promise<OpenedContract<Burner>> {
    const ui = provider.ui()
    const address = await ui.inputAddress('Burner address', BURNER)
    if (!(await provider.isContractDeployed(address))) {
        throw new Error(`No contract deployed at ${address.toString()}`)
    }
    return provider.open(Burner.createFromAddress(address))
}

/** Open the burner, print its state, and check the connected wallet may act on it. */
export async function beginOwnerAction(
    provider: NetworkProvider,
    action: string,
    opts: { requireOwner?: boolean } = {},
): Promise<Session | null> {
    const ui = provider.ui()
    const burner = await openBurner(provider)

    const ownership = await burner.getOwnership()
    const progress = await burner.getProgress()
    const data = await burner.getBurnerData()
    const state = await provider.provider(burner.address).getState()
    const sender = provider.sender().address

    ui.write('')
    ui.write(`Burner        ${burner.address.toString()}`)
    ui.write(`Balance       ${gram(state.balance)}`)
    ui.write(
        `Owner         ${ownership.owner?.toString() ?? 'none -- ownership dropped, nothing can be done'}`,
    )
    if (ownership.pendingOwner) {
        ui.write(`  pending     ${ownership.pendingOwner.toString()} (has not claimed yet)`)
    }
    ui.write(`Connected as  ${sender?.toString() ?? 'unknown'}`)
    ui.write('')
    ui.write(`hGRAM wallet  ${data.hgramWallet?.toString() ?? 'not discovered'}`)
    ui.write(`HPO wallet    ${data.hpoWallet?.toString() ?? 'not discovered'}`)
    ui.write(`Pending       ${fromNano(progress.hgramPending)} hGRAM, ${fromNano(progress.hpoPending)} HPO`)
    ui.write('')
    ui.write(`Action        ${action}`)
    ui.write('')

    if (sender === undefined) {
        ui.write('No sender address available. Aborting.')
        return null
    }

    if ((opts.requireOwner ?? true) && !ownership.owner?.equals(sender)) {
        ui.write('REFUSING: the connected wallet is not the owner, so this would only bounce.')
        if (ownership.owner === null) {
            ui.write('Ownership has been dropped. This contract can no longer be acted on by anyone.')
        }
        return null
    }

    return {
        burner,
        owner: ownership.owner,
        pendingOwner: ownership.pendingOwner,
        sender,
        balance: state.balance,
        hgramPending: progress.hgramPending,
        hpoPending: progress.hpoPending,
    }
}

/** A yes/no gate. Defaults to no, because every one of these scripts moves something. */
export async function confirm(provider: NetworkProvider, question: string): Promise<boolean> {
    const answer = await provider.ui().choose(question, ['no', 'yes'], (c) => c)
    if (answer !== 'yes') {
        provider.ui().write('Aborted. Nothing was sent.')
        return false
    }
    return true
}

/** Read a jetton wallet's balance, or 0 when the wallet has never been deployed. */
export async function jettonBalance(provider: NetworkProvider, wallet: Address): Promise<bigint> {
    if (!(await provider.isContractDeployed(wallet))) {
        return 0n
    }
    const { stack } = await provider.provider(wallet).get('get_wallet_data', [])
    return stack.readBigNumber()
}

/** Ask a jetton master where an owner's wallet lives. Works for HPO, hGRAM and any TEP-89 jetton. */
export async function walletAddressOf(
    provider: NetworkProvider,
    master: Address,
    owner: Address,
): Promise<Address> {
    const { beginCell } = await import('@ton/core')
    const { stack } = await provider
        .provider(master)
        .get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])
    return stack.readAddress()
}
