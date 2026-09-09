import { fromNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'

import { BURNER, DEDUST_POOL } from '../wrappers/addresses'
import { Burner } from '../wrappers/Burner'

const gram = (v: bigint) => `${fromNano(v)} GRAM`
const hgram = (v: bigint) => `${fromNano(v)} hGRAM`
const hpo = (v: bigint) => `${fromNano(v)} HPO`

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const address = await ui.inputAddress('Burner address', BURNER)
    const burner = provider.open(Burner.createFromAddress(address))

    if (!(await provider.isContractDeployed(burner.address))) {
        ui.write(`Not deployed: ${burner.address.toString()}`)
        return
    }

    const data = await burner.getBurnerData()
    const ownership = await burner.getOwnership()
    const progress = await burner.getProgress()
    const depositable = await burner.getDepositable()
    const state = await provider.provider(burner.address).getState()

    ui.write(`Burner       ${burner.address.toString()}`)
    ui.write(`Balance      ${gram(state.balance)}`)
    ui.write(
        `Owner        ${ownership.owner?.toString() ?? 'none -- ownership dropped, this contract is immutable'}`,
    )
    if (ownership.pendingOwner) {
        ui.write(`  pending    ${ownership.pendingOwner.toString()} (has not claimed yet)`)
    }
    ui.write(`hGRAM wallet ${data.hgramWallet?.toString() ?? 'NOT DISCOVERED YET'}`)
    ui.write(`HPO wallet   ${data.hpoWallet?.toString() ?? 'NOT DISCOVERED YET'}`)
    ui.write('')
    ui.write(`Received     ${gram(data.totalReceived)}`)
    ui.write(`Staked       ${gram(data.totalDeposited)} over ${String(progress.depositCount)} deposits`)
    ui.write(`Swapped      ${hgram(data.totalSwapped)} over ${String(progress.swapCount)} swaps`)
    ui.write(`Burned       ${hpo(data.totalBurned)} over ${String(progress.burnCount)} burns`)
    ui.write('')
    ui.write(
        depositable > 0n
            ? `Next stake   ${gram(depositable)}`
            : 'Next stake   nothing yet -- balance is at the reserve, waiting for a payment',
    )

    // A pending amount that does not clear is the signal that a leg is stuck and needs a poke.
    if (progress.hgramPending > 0n || progress.hpoPending > 0n) {
        ui.write('')
        ui.write('MID-CYCLE:')
        if (progress.hgramPending > 0n) {
            ui.write(`  ${hgram(progress.hgramPending)} waiting to be swapped`)
        }
        if (progress.hpoPending > 0n) {
            ui.write(`  ${hpo(progress.hpoPending)} waiting to be burned`)
        }
        ui.write('  If this does not clear on its own, send the burner a small amount of GRAM.')
        ui.write('  Anyone can do that; it retries the stuck leg, and needs no owner.')
        if (ownership.owner) {
            ui.write('  If the route is dead rather than slow, the owner can withdraw these and')
            ui.write('  then reset_pending, so later payments stop retrying a doomed leg.')
        }
    }

    // The health check that matters: a burner pointed at a pool that moved on.
    try {
        const { stack } = await provider.provider(DEDUST_POOL).get('get_reserves', [])
        const reserveHgram = stack.readBigNumber()
        const reserveHpo = stack.readBigNumber()

        ui.write('')
        ui.write(`Pool         ${hgram(reserveHgram)} / ${hpo(reserveHpo)}`)
        if (reserveHgram > 0n && depositable > 0n) {
            // Rough: the stake converts to hGRAM at about the current rate before it hits the pool.
            const impact = Number((depositable * 10000n) / reserveHgram) / 100
            ui.write(`Impact       the next cycle moves this pool roughly ${impact.toFixed(1)}%`)
        }
        if (reserveHgram === 0n) {
            ui.write('')
            ui.write('WARNING: the pool this burner is hardcoded to has no liquidity left.')
            ui.write('First, stop the flow at the source: set the treasury\'s borrower_fee to 0,')
            ui.write('which needs no upgrade and takes effect immediately. Then recover what is')
            ui.write('stuck here -- withdrawJetton, then resetPending -- so later payments stop')
            ui.write('retrying a doomed leg.')
            ui.write('')
            ui.write('The pool is compiled in, so repointing it means an upgrade: change the')
            ui.write('constant, then npx blueprint run upgradeBurner. The dry run prints the route')
            ui.write('change as a diff line, so check it says what you meant. If ownership has')
            ui.write('been dropped, no upgrade is possible and the answer is a new burner at a new')
            ui.write('address plus a treasury upgrade to name it.')
        }
    } catch {
        ui.write('')
        ui.write('WARNING: the pool did not answer get_reserves. See the note above.')
    }
}
