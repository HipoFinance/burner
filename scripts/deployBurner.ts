import { Address, toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'

import {
    DEDUST_HGRAM_VAULT,
    DEDUST_POOL,
    HGRAM,
    HIPO_PARENT,
    HIPO_TREASURY,
    HPO,
} from '../wrappers/addresses'
import { Burner, emptyBurnerConfig } from '../wrappers/Burner'

/**
 * The route the contract has hardcoded, checked against the chain before anything is sent.
 *
 * A wrong constant is correctable now that the burner is upgradable, but correcting it still means
 * a reviewed upgrade against a contract that has already been paid -- and if the address itself is
 * wrong, a redeploy plus a treasury upgrade to name the new one. Cheaper to be right here.
 */
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const code = await compile('Burner')

    // The owner is the rescue hatch, and since 2026-09-09 also the upgrade authority: it can move
    // assets that fall out of the burn cycle, and it can install new code. It is part of the state
    // the address is derived from, so it has to be decided before deployment, not after.
    const sender = provider.sender().address
    ui.write('The owner can withdraw GRAM, hGRAM, HPO and anything else from this contract, and')
    ui.write('can replace its code with op::upgrade_code. Use a multisig.')
    ui.write('Ownership can be handed over later, or given up entirely with drop_ownership,')
    ui.write('which freezes the code and closes the hatch together, without a redeploy.')
    ui.write('')
    const owner = await ui.inputAddress('Owner address', sender)
    ui.write(`Owner          : ${owner.toString()}`)
    ui.write('')

    const burner = provider.open(Burner.createFromConfig(emptyBurnerConfig(owner), code))

    ui.write('Verifying the hardcoded route against the chain...')
    const problems: string[] = []

    // 1. The treasury's parent must be the hGRAM master the contract will discover against.
    // parent sits at index 6. It was 5 until a deficit field was inserted ahead of it, which made
    // this read an integer as an address and abort the whole check. The tuple only grows by
    // appending now, so 6 is stable, but skipping a fixed count is only ever as good as the last
    // time someone looked -- if this throws, count the fields in get_treasury_state again.
    const treasuryParentIndex = 6
    const { stack: treasuryState } = await provider.provider(HIPO_TREASURY).get('get_treasury_state', [])
    for (let i = 0; i < treasuryParentIndex; i++) {
        treasuryState.skip(1)
    }
    const parent = treasuryState.readAddress()
    ui.write(`  treasury parent   ${parent.toString()}`)
    if (!parent.equals(HIPO_PARENT)) {
        problems.push(`treasury parent is ${parent.toString()}, contract has ${HIPO_PARENT.toString()}`)
    }

    // 2. The pool must still be the hGRAM/HPO pair, and still have liquidity.
    const { stack: assets } = await provider.provider(DEDUST_POOL).get('get_assets', [])
    const asset0 = assets.readCell().beginParse()
    const asset1 = assets.readCell().beginParse()
    const readAsset = (s: ReturnType<typeof asset0.clone>) => {
        const kind = s.loadUint(4)
        if (kind !== 1) return null
        const wc = s.loadInt(8)
        return new Address(wc, Buffer.from(s.loadUintBig(256).toString(16).padStart(64, '0'), 'hex'))
    }
    const a0 = readAsset(asset0)
    const a1 = readAsset(asset1)
    ui.write(`  pool assets       ${a0?.toString() ?? 'native'} / ${a1?.toString() ?? 'native'}`)
    if (!a0?.equals(HGRAM) || !a1?.equals(HPO)) {
        problems.push('pool assets are not [hGRAM, HPO]')
    }

    const { stack: reserves } = await provider.provider(DEDUST_POOL).get('get_reserves', [])
    const reserveHgram = reserves.readBigNumber()
    const reserveHpo = reserves.readBigNumber()
    ui.write(`  pool reserves     ${String(reserveHgram)} hGRAM / ${String(reserveHpo)} HPO`)
    if (reserveHgram === 0n || reserveHpo === 0n) {
        problems.push('the pool has no liquidity')
    }

    // 3. The DeDust vault must still be the vault for hGRAM.
    const { stack: vaultAsset } = await provider.provider(DEDUST_HGRAM_VAULT).get('get_asset', [])
    const va = readAsset(vaultAsset.readCell().beginParse())
    ui.write(`  vault asset       ${va?.toString() ?? 'native'}`)
    if (!va?.equals(HGRAM)) {
        problems.push(`the DeDust vault at the hardcoded address is not the hGRAM vault`)
    }

    if (problems.length > 0) {
        ui.write('')
        ui.write('REFUSING TO DEPLOY. The route baked into contracts/imports/constants.fc no longer')
        ui.write('matches the chain, and this contract cannot be repointed after deployment:')
        for (const problem of problems) {
            ui.write(`  - ${problem}`)
        }
        return
    }
    ui.write('  route matches the contract. OK.')
    ui.write('')

    ui.write(`Burner address : ${burner.address.toString()}`)
    ui.write(`           raw : ${burner.address.toRawString()}`)
    ui.write('')
    ui.write('After deploying, put this in contract/contracts/imports/constants.fc:')
    ui.write(`  const int burner::wc = ${String(burner.address.workChain)};`)
    ui.write(`  const int burner::addr = 0x${burner.address.hash.toString('hex')};`)
    ui.write('')
    ui.write('Only then set borrower_fee to a non-zero value. While it is 0 the treasury sends')
    ui.write('nothing here, so a wrong constant is inert until that call.')
    ui.write('')

    if (await provider.isContractDeployed(burner.address)) {
        ui.write('Already deployed. Nothing to do.')
        return
    }

    ui.write('The burn route is compiled in. Changing it later means a reviewed upgrade against a')
    ui.write('contract that is already being paid, so get it right here.')
    ui.write(`The owner will be ${owner.toString()}.`)
    const confirm = await ui.choose('Deploy this burner?', ['no', 'yes'], (choice) => choice)
    if (confirm !== 'yes') {
        ui.write('Aborted.')
        return
    }

    // 2 GRAM covers the 1 GRAM reserve, the two discovery messages deployment sends on its own,
    // and storage for a long time. It also leaves enough above the reserve that the first poke can
    // stake -- budget::min_deposit is 1 GRAM -- which is how the route gets proven end to end
    // before the treasury pays anything in.
    await burner.sendDeploy(provider.sender(), toNano('2'))
    await provider.waitForDeploy(burner.address)

    ui.write('Deployed. Deployment itself runs TEP-89 discovery against both masters, so the two')
    ui.write('wallets should already be known -- check with: npx blueprint run showBurner')
    ui.write('')
    ui.write('The deploy message only discovers; it does not stake. Send the burner a small amount')
    ui.write('of GRAM to run one full cycle on the deployment balance and prove the route end to')
    ui.write('end -- stake, swap, burn -- before setting the treasury\'s borrower_fee.')
}
