import { Address, SendMode, fromNano, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { beginOwnerAction, confirm, gram, jettonBalance } from '../wrappers/operate'
import { gramTransfer, jettonTransfer } from '../wrappers/rescue'

const POOL = Address.parse('EQCXJu7zUBQILdzt1nIzz_NhDfVZ-FyEdnccFDYDPRaAqfqU')

/**
 * The one script to reach for when the route has died.
 *
 * Diagnoses first, then walks the whole recovery in order: pull the stuck tokens out, square the
 * pending amounts so later payments stop retrying a doomed leg, and optionally take the GRAM too.
 * Each step is confirmed separately, so it can be stopped part way.
 *
 * The individual scripts do the same things one at a time. This exists so that nobody has to
 * remember the order, or remember that a withdrawal without resetPending leaves the contract
 * retrying forever.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const session = await beginOwnerAction(provider, 'guided recovery from a dead route')
    if (session === null) {
        return
    }

    const data = await session.burner.getBurnerData()

    // 1. Is the route actually dead, or is this just a snapshot mid-cycle?
    ui.write('Checking the pool...')
    let poolDead: boolean
    try {
        const { stack } = await provider.provider(POOL).get('get_reserves', [])
        const reserveHgram = stack.readBigNumber()
        const reserveHpo = stack.readBigNumber()
        ui.write(`  reserves  ${fromNano(reserveHgram)} hGRAM / ${fromNano(reserveHpo)} HPO`)
        poolDead = reserveHgram === 0n || reserveHpo === 0n
    } catch {
        ui.write('  the pool did not answer get_reserves')
        poolDead = true
    }
    ui.write(poolDead ? '  the pool looks dead.' : '  the pool looks alive.')
    ui.write('')

    const heldHgram = data.hgramWallet ? await jettonBalance(provider, data.hgramWallet) : 0n
    const heldHpo = data.hpoWallet ? await jettonBalance(provider, data.hpoWallet) : 0n

    ui.write('Inside the burner right now:')
    ui.write(`  GRAM   ${gram(session.balance)}`)
    ui.write(`  hGRAM  ${fromNano(heldHgram)}  (pending ${fromNano(session.hgramPending)})`)
    ui.write(`  HPO    ${fromNano(heldHpo)}  (pending ${fromNano(session.hpoPending)})`)
    ui.write('')

    if (!poolDead && heldHgram === 0n && heldHpo === 0n) {
        ui.write('The route is alive and nothing is sitting here. There is nothing to rescue.')
        ui.write('If you saw a stuck balance a moment ago, it has since cleared on its own.')
        return
    }

    if (!poolDead && (heldHgram > 0n || heldHpo > 0n)) {
        ui.write('The route looks alive, so these tokens may simply be mid-cycle and about to')
        ui.write('clear. Re-run showBurner in a minute before rescuing anything: a poke -- any')
        ui.write('small GRAM transfer, from anyone -- retries a stalled leg without an owner.')
        ui.write('')
        if (!(await confirm(provider, 'Continue with the rescue anyway?'))) {
            return
        }
    }

    const destination = await ui.inputAddress('Recover everything to', session.sender)
    ui.write('')

    // 2. Pull the jettons out.
    for (const [label, wallet, held] of [
        ['hGRAM', data.hgramWallet, heldHgram],
        ['HPO', data.hpoWallet, heldHpo],
    ] as const) {
        if (wallet === null || held === 0n) {
            continue
        }
        ui.write(`Step: move ${fromNano(held)} ${label} to ${destination.toString()}`)
        if (label === 'HPO') {
            ui.write('  (this takes HPO out rather than burning it -- only right if it is stuck)')
        }
        if (await confirm(provider, `Move the ${label}?`)) {
            await session.burner.sendWithdraw(provider.sender(), {
                value: toNano('0.3'),
                mode: SendMode.PAY_GAS_SEPARATELY,
                message: jettonTransfer(wallet, {
                    to: destination,
                    responseTo: destination,
                    amount: held,
                    attached: toNano('0.2'),
                }),
            })
            ui.write(`  sent. Wait for it to land before the next step.`)
        }
        ui.write('')
    }

    // 3. Square the books, or the contract retries those legs forever.
    ui.write('Step: reset the pending amounts to zero.')
    ui.write('  Without this the contract still believes those tokens are here, and every later')
    ui.write('  payment retries a leg that cannot succeed, spending gas each time.')
    if (await confirm(provider, 'Reset pending to zero?')) {
        await session.burner.sendResetPending(provider.sender(), {
            value: toNano('0.05'),
            hgramPending: 0n,
            hpoPending: 0n,
        })
        ui.write('  sent.')
    }
    ui.write('')

    // 4. The GRAM, last, because taking it stops the contract.
    ui.write(`Step: recover the ${gram(session.balance)} GRAM balance.`)
    ui.write('  Do this only if you are abandoning this burner. Taking everything leaves nothing')
    ui.write('  for storage and the account will freeze; leaving it lets the burner resume if the')
    ui.write('  route comes back.')
    ui.write('')
    ui.write('  Remember to stop the flow at the source too: set the treasury\'s borrower_fee to 0,')
    ui.write('  which needs no upgrade, or payments will keep arriving here.')
    ui.write('')
    if (await confirm(provider, 'Take the whole GRAM balance and stop the contract?')) {
        await session.burner.sendWithdraw(provider.sender(), {
            value: toNano('0.05'),
            mode: SendMode.CARRY_ALL_REMAINING_BALANCE,
            message: gramTransfer(destination, 0n),
        })
        ui.write('  sent.')
    }

    ui.write('')
    ui.write('Recovery finished. Check the result with: npx blueprint run showBurner')
}
