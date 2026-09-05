import { fromNano, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { beginOwnerAction, confirm, jettonBalance } from '../wrappers/operate'

/**
 * Square the contract's books with reality.
 *
 * hgram_pending and hpo_pending are what make a failed leg retryable. After a withdrawal they are
 * wrong: they claim tokens are in the wallets that are no longer there, so every later payment
 * retries a leg that cannot succeed, bounces, re-adds itself, and spends gas each time.
 *
 * This is the second half of any withdrawal of stuck tokens. It is not needed after withdrawing
 * GRAM.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'reset the pending amounts')
    if (session === null) {
        return
    }

    const data = await session.burner.getBurnerData()
    const heldHgram = data.hgramWallet ? await jettonBalance(provider, data.hgramWallet) : 0n
    const heldHpo = data.hpoWallet ? await jettonBalance(provider, data.hpoWallet) : 0n

    ui.write('What the contract believes, against what its wallets actually hold:')
    ui.write('')
    ui.write(`  hGRAM  pending ${fromNano(session.hgramPending)}   actually held ${fromNano(heldHgram)}`)
    ui.write(`  HPO    pending ${fromNano(session.hpoPending)}   actually held ${fromNano(heldHpo)}`)
    ui.write('')

    if (session.hgramPending === heldHgram && session.hpoPending === heldHpo) {
        ui.write('These already agree. Nothing needs resetting.')
        if (!(await confirm(provider, 'Set them anyway?'))) {
            return
        }
    }

    ui.write('Setting the pending amounts to what the wallets really hold is almost always right.')
    const how = await ui.choose(
        'Set pending to?',
        ['what the wallets actually hold', 'zero', 'values I will type'],
        (c) => c,
    )

    let hgramPending = heldHgram
    let hpoPending = heldHpo
    if (how === 'zero') {
        hgramPending = 0n
        hpoPending = 0n
    } else if (how === 'values I will type') {
        hgramPending = toNano((await ui.input('hgram_pending, in hGRAM')).trim())
        hpoPending = toNano((await ui.input('hpo_pending, in HPO')).trim())
    }

    ui.write('')
    ui.write(`About to set pending to ${fromNano(hgramPending)} hGRAM and ${fromNano(hpoPending)} HPO.`)
    ui.write('')
    if (!(await confirm(provider, 'Send it?'))) {
        return
    }

    await session.burner.sendResetPending(provider.sender(), {
        value: toNano('0.05'),
        hgramPending,
        hpoPending,
    })
    ui.write('Sent. Confirm with: npx blueprint run showBurner')
}
