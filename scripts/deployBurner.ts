import { Address, toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'

import { Burner, emptyBurnerConfig } from '../wrappers/Burner'

/**
 * The route the contract has hardcoded, checked against the chain before anything is sent. The
 * burner has no owner and no upgrade path, so a wrong constant here is not a misconfiguration
 * that can be corrected later -- it is a redeploy plus a treasury upgrade to name the new address.
 */
const POOL = Address.parse('EQCXJu7zUBQILdzt1nIzz_NhDfVZ-FyEdnccFDYDPRaAqfqU')
const HIPO_TREASURY = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')
const HIPO_PARENT = Address.parse('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
const DEDUST_HGRAM_VAULT = Address.parse('EQCRjILmJD0ZD7y6POFyicCx20PoypkEwHJ64AMJ7vwkXGjm')
const HGRAM = Address.parse('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
const HPO = Address.parse('EQDQEUr0LPi8m6D6F0Wrvuok7tZbAcr0yn2Y7hK291MMzMjM')

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const code = await compile('Burner')

    // The owner is the rescue hatch: it can move assets that fall out of the burn cycle, but it
    // cannot redirect the burn or change the code. It is part of the state the address is derived
    // from, so it has to be decided before deployment, not after.
    const sender = provider.sender().address
    ui.write('The owner can withdraw GRAM, hGRAM, HPO and anything else from this contract.')
    ui.write('It cannot redirect the burn or change the code. Prefer a multisig.')
    ui.write('Ownership can be handed over later, or given up entirely with drop_ownership,')
    ui.write('which makes the contract permanently immutable without a redeploy.')
    ui.write('')
    const owner = await ui.inputAddress('Owner address', sender)
    ui.write(`Owner          : ${owner.toString()}`)
    ui.write('')

    const burner = provider.open(Burner.createFromConfig(emptyBurnerConfig(owner), code))

    ui.write('Verifying the hardcoded route against the chain...')
    const problems: string[] = []

    // 1. The treasury's parent must be the hGRAM master the contract will discover against.
    const { stack: treasuryState } = await provider.provider(HIPO_TREASURY).get('get_treasury_state', [])
    for (let i = 0; i < 5; i++) {
        treasuryState.skip(1)
    }
    const parent = treasuryState.readAddress()
    ui.write(`  treasury parent   ${parent.toString()}`)
    if (!parent.equals(HIPO_PARENT)) {
        problems.push(`treasury parent is ${parent.toString()}, contract has ${HIPO_PARENT.toString()}`)
    }

    // 2. The pool must still be the hGRAM/HPO pair, and still have liquidity.
    const { stack: assets } = await provider.provider(POOL).get('get_assets', [])
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

    const { stack: reserves } = await provider.provider(POOL).get('get_reserves', [])
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

    ui.write('The burn route is fixed in the code and cannot be changed after deployment.')
    ui.write(`The owner will be ${owner.toString()}.`)
    const confirm = await ui.choose('Deploy this burner?', ['no', 'yes'], (choice) => choice)
    if (confirm !== 'yes') {
        ui.write('Aborted.')
        return
    }

    // 2 GRAM covers the 1 GRAM reserve, the two discovery messages deployment sends on its own,
    // and storage for a long time.
    await burner.sendDeploy(provider.sender(), toNano('2'))
    await provider.waitForDeploy(burner.address)

    ui.write('Deployed. Deployment itself runs TEP-89 discovery against both masters, so the two')
    ui.write('wallets should already be known -- check with: npx blueprint run showBurner')
}
