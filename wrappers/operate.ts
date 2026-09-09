import { Address, Cell, fromNano } from '@ton/core'
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
    /**
     * Who will sign. The connected wallet when there is one, otherwise the address the operator
     * named -- with `--deeplink` there is no wallet to ask, and with a multisig owner there never
     * could be.
     */
    sender: Address
    /** False when there is no wallet behind `sender`, so nothing here can actually send. */
    connected: boolean
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
    ui.write(`Connected as  ${sender?.toString() ?? 'no connected wallet'}`)
    ui.write('')
    ui.write(`hGRAM wallet  ${data.hgramWallet?.toString() ?? 'not discovered'}`)
    ui.write(`HPO wallet    ${data.hpoWallet?.toString() ?? 'not discovered'}`)
    ui.write(`Pending       ${fromNano(progress.hgramPending)} hGRAM, ${fromNano(progress.hpoPending)} HPO`)
    ui.write('')
    ui.write(`Action        ${action}`)
    ui.write('')

    // `--deeplink` has no connected wallet at all: blueprint's DeeplinkProvider returns undefined
    // from address(). Neither does the multisig case, where the signer is a contract and nothing
    // here can sign for it. Aborting on that made every owner script unusable in exactly the two
    // situations they exist for, so ask instead -- the owner check below still runs, against the
    // address given, and it is still the thing that stops a wasted bounce.
    let acting = sender
    if (acting === undefined) {
        ui.write('')
        ui.write('No connected wallet. Whatever this sends will be issued as a ton:// link, and the')
        ui.write('request is printed below in full so it can go into a multisig instead.')
        ui.write('Say which address will actually sign, so the owner check can still run.')
        // claimOwnership is the one action the owner must NOT sign, so offer the nominee there.
        const likely =
            (opts.requireOwner ?? true) ? ownership.owner : (ownership.pendingOwner ?? ownership.owner)
        acting = await ui.inputAddress('Address that will sign', likely ?? undefined)
        ui.write('')
    }

    if ((opts.requireOwner ?? true) && !ownership.owner?.equals(acting)) {
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
        sender: acting,
        connected: sender !== undefined,
        balance: state.balance,
        hgramPending: progress.hgramPending,
        hpoPending: progress.hpoPending,
    }
}

/**
 * Print an owner action as the three fields a multisig proposal needs.
 *
 * The owner of this contract can be -- and should be -- a multisig, and then nothing on this
 * machine can sign for it: the scripts can compute the request but not send it. So every action is
 * printed before it is offered, in the exact form a proposal is built from, and answering "no" to
 * the send is a first-class way to use these scripts rather than an abort.
 *
 * The body comes from the same builder the send method uses, so this is the cell that would go on
 * chain and not a description of it.
 */
export function printRequest(
    provider: NetworkProvider,
    opts: { to: Address; value: bigint; body: Cell; note?: string },
): void {
    const ui = provider.ui()
    ui.write('  ---- request ------------------------------------------------------------')
    ui.write(`  To       ${opts.to.toString()}`)
    ui.write(`  Value    ${gram(opts.value)}  (${opts.value.toString()} nanoton)`)
    ui.write('  Bounce   true')
    ui.write(`  Body     ${opts.body.toBoc().toString('base64')}`)
    if (opts.note !== undefined) {
        ui.write(`  Note     ${opts.note}`)
    }
    ui.write('  -------------------------------------------------------------------------')
}

/** A yes/no gate. Defaults to no, because every one of these scripts moves something. */
export async function confirm(provider: NetworkProvider, question: string): Promise<boolean> {
    const answer = await provider.ui().choose(question, ['no', 'yes'], (c) => c)
    if (answer !== 'yes') {
        provider.ui().write('Not sent. The request above is printed in full if you need it.')
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
