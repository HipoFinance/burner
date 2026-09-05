import {
    Blockchain,
    SandboxContract,
    SendMessageResult,
    TreasuryContract,
    createShardAccount,
} from '@ton/sandbox'
import { Address, beginCell, Cell, toNano } from '@ton/core'
import { compile } from '@ton/blueprint'

import hpoMinterArtifact from './fixtures/HpoMinter.compiled.json'
import hpoWalletArtifact from './fixtures/HpoWallet.compiled.json'
import hipoParentArtifact from './fixtures/HipoParent.compiled.json'
import hipoWalletArtifact from './fixtures/HipoWallet.compiled.json'

import { Burner, burnerConfigToCell, emptyBurnerConfig } from '../wrappers/Burner'
import { MockDedust, mockDedustConfigToCell } from '../wrappers/MockDedust'
import { mockHipoTreasuryConfigToCell } from '../wrappers/MockHipoTreasury'

/**
 * The addresses the burner has hardcoded. They are compile-time constants with no setter, so the
 * tests place the real contracts and the stand-ins at exactly these addresses -- which means a
 * typo in constants.fc shows up here as a failing test rather than on mainnet.
 */
export const HIPO_TREASURY = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')
export const HIPO_PARENT = Address.parse('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
export const HPO_MASTER = Address.parse('EQDQEUr0LPi8m6D6F0Wrvuok7tZbAcr0yn2Y7hK291MMzMjM')
export const DEDUST_HGRAM_VAULT = Address.parse('EQCRjILmJD0ZD7y6POFyicCx20PoypkEwHJ64AMJ7vwkXGjm')
export const DEDUST_HPO_VAULT = Address.parse('EQBQ50kTIWywaTa01p_JnHhkaiEukwdt1WPvdHIvP1V5SPMy')
export const DEDUST_POOL = Address.parse('EQCXJu7zUBQILdzt1nIzz_NhDfVZ-FyEdnccFDYDPRaAqfqU')

export const Op = {
    transfer: 0xf8a7ea5,
    sendTokens: 0x0f8a7ea5,
    transferNotification: 0x7362d09c,
    internalTransfer: 0x178d4519,
    excesses: 0xd53276db,
    burn: 0x595f07bc,
    burnNotification: 0x7bdd97de,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,
    mint: 0x642b7d07,
    depositCoins: 0x3d3761a6,
    dedustSwap: 0xe3a0d482,
    takeBorrowerFee: 0x5e2d81f4,
} as const

export const hpoMinterCode = Cell.fromHex(hpoMinterArtifact.hex)
export const hpoWalletCode = Cell.fromHex(hpoWalletArtifact.hex)
export const hipoParentCode = Cell.fromHex(hipoParentArtifact.hex)
export const hipoWalletCode = Cell.fromHex(hipoWalletArtifact.hex)

/** Storage for the real HPO minter: supply, admin, transfer_admin, ^wallet_code, ^content. */
export function hpoMinterData(admin: Address): Cell {
    return beginCell()
        .storeCoins(0)
        .storeAddress(admin)
        .storeAddress(null)
        .storeRef(hpoWalletCode)
        .storeRef(beginCell().storeStringRefTail('https://hpo.hipo.finance/hpo.json').endCell())
        .endCell()
}

/** Storage for the real Hipo parent: total_tokens, treasury, ^wallet_code, ^content. */
export function hipoParentData(): Cell {
    return beginCell()
        .storeCoins(0)
        .storeAddress(HIPO_TREASURY)
        .storeRef(hipoWalletCode)
        .storeRef(beginCell().storeStringRefTail('https://hipo.finance/hgram.json').endCell())
        .endCell()
}

export function mintHpoMessage(to: Address, amount: bigint, totalTon: bigint, forwardTon: bigint): Cell {
    const internal = beginCell()
        .storeUint(Op.internalTransfer, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(null)
        .storeAddress(to)
        .storeCoins(forwardTon)
        .storeMaybeRef(null)
        .endCell()
    return beginCell()
        .storeUint(Op.mint, 32)
        .storeUint(0, 64)
        .storeAddress(to)
        .storeCoins(totalTon)
        .storeRef(internal)
        .endCell()
}

/** Ask a master where a wallet lives, rather than re-deriving its state-init layout here. */
export async function walletAddressOf(
    blockchain: Blockchain,
    master: Address,
    owner: Address,
): Promise<Address> {
    const { stack } = await blockchain
        .provider(master)
        .get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])
    return stack.readAddress()
}

export interface Fixture {
    blockchain: Blockchain
    deployResult: SendMessageResult
    deployer: SandboxContract<TreasuryContract>
    treasury: SandboxContract<TreasuryContract>
    stranger: SandboxContract<TreasuryContract>
    owner: SandboxContract<TreasuryContract>
    burner: SandboxContract<Burner>
    dedust: SandboxContract<MockDedust>
    burnerHgramWallet: Address
    burnerHpoWallet: Address
    /** HPO supply as the master reports it -- the number a burn must actually move. */
    hpoSupply: () => Promise<bigint>
    /** hGRAM supply as the Hipo parent reports it -- the number a deposit must move. */
    hgramSupply: () => Promise<bigint>
    hgramBalance: (owner: Address) => Promise<bigint>
    hpoBalance: (owner: Address) => Promise<bigint>
}

export interface SetupOptions {
    /** hGRAM minted per GRAM staked, scaled by 1e9. Live rate on 2026-09-04 was ~0.86. */
    stakeRate?: bigint
    /** HPO paid per hGRAM, scaled by 1e9. Live pool price was ~718 HPO per hGRAM. */
    swapRate?: bigint
    /** MockDedust mode: fill, refund or silent. */
    mode?: number
    /** Whether the mock treasury refuses the deposit. */
    treasuryRejects?: boolean
    /** HPO handed to the mock vault so it has something to sell. */
    dedustInventory?: bigint
    burnerBalance?: bigint
    /** The rescue-hatch owner. Defaults to the `owner` treasury contract. */
    owner?: Address | null
}

export async function setup(options: SetupOptions = {}): Promise<Fixture> {
    const stakeRate = options.stakeRate ?? 860000000n // 1 / 1.16229
    const swapRate = options.swapRate ?? 718000000000n // 147030.1 HPO / 204.6 hGRAM
    const mode = options.mode ?? 0
    const dedustInventory = options.dedustInventory ?? toNano('500000000')
    const burnerBalance = options.burnerBalance ?? toNano('2')

    const blockchain = await Blockchain.create()
    const deployer = await blockchain.treasury('deployer')
    const treasury = await blockchain.treasury('hipoTreasury')
    const stranger = await blockchain.treasury('stranger')
    const owner = await blockchain.treasury('owner')

    // The real HPO minter, at the address the burner has hardcoded.
    await blockchain.setShardAccount(
        HPO_MASTER,
        createShardAccount({
            address: HPO_MASTER,
            code: hpoMinterCode,
            data: hpoMinterData(deployer.address),
            balance: toNano('10'),
            workchain: 0,
        }),
    )

    // The real Hipo parent, wired to the real Hipo wallet code. The mint, the notification and
    // send_tokens all run production code from here down.
    await blockchain.setShardAccount(
        HIPO_PARENT,
        createShardAccount({
            address: HIPO_PARENT,
            code: hipoParentCode,
            data: hipoParentData(),
            balance: toNano('10'),
            workchain: 0,
        }),
    )

    // A stand-in for the treasury's deposit path only.
    const treasuryCode = await compile('MockHipoTreasury')
    await blockchain.setShardAccount(
        HIPO_TREASURY,
        createShardAccount({
            address: HIPO_TREASURY,
            code: treasuryCode,
            data: mockHipoTreasuryConfigToCell({
                parent: HIPO_PARENT,
                rate: stakeRate,
                fee: toNano("0.05"), // live fee is 0.0088; padded so the real parent and wallet have gas headroom
                reject: options.treasuryRejects ?? false,
            }),
            balance: toNano('10'),
            workchain: 0,
        }),
    )

    const vaultHgramWallet = await walletAddressOf(blockchain, HIPO_PARENT, DEDUST_HGRAM_VAULT)
    const vaultHpoWallet = await walletAddressOf(blockchain, HPO_MASTER, DEDUST_HGRAM_VAULT)

    // The stand-in for DeDust, at the hGRAM vault address the burner sends the swap to.
    const dedustCode = await compile('MockDedust')
    await blockchain.setShardAccount(
        DEDUST_HGRAM_VAULT,
        createShardAccount({
            address: DEDUST_HGRAM_VAULT,
            code: dedustCode,
            data: mockDedustConfigToCell({
                ownHgramWallet: vaultHgramWallet,
                ownHpoWallet: vaultHpoWallet,
                rate: swapRate,
                mode,
            }),
            balance: toNano('100'),
            workchain: 0,
        }),
    )
    const dedust = blockchain.openContract(MockDedust.createFromAddress(DEDUST_HGRAM_VAULT))

    // Give the vault HPO to sell.
    await deployer.send({
        to: HPO_MASTER,
        value: toNano('2'),
        body: mintHpoMessage(DEDUST_HGRAM_VAULT, dedustInventory, toNano('1'), toNano('0.05')),
    })

    const burnerCode = await compile('Burner')
    const ownerAddress = options.owner === undefined ? owner.address : options.owner
    const burner = blockchain.openContract(
        Burner.createFromConfig(emptyBurnerConfig(ownerAddress), burnerCode),
    )
    const deployResult = await burner.sendDeploy(deployer.getSender(), burnerBalance)

    const burnerHgramWallet = await walletAddressOf(blockchain, HIPO_PARENT, burner.address)
    const burnerHpoWallet = await walletAddressOf(blockchain, HPO_MASTER, burner.address)

    const hpoSupply = async (): Promise<bigint> => {
        const { stack } = await blockchain.provider(HPO_MASTER).get('get_jetton_data', [])
        return stack.readBigNumber()
    }

    const hgramSupply = async (): Promise<bigint> => {
        const { stack } = await blockchain.provider(HIPO_PARENT).get('get_jetton_data', [])
        return stack.readBigNumber()
    }

    const balanceOf = async (master: Address, owner: Address, method: string): Promise<bigint> => {
        const wallet = await walletAddressOf(blockchain, master, owner)
        const contract = await blockchain.getContract(wallet)
        if (contract.accountState?.type !== 'active') {
            return 0n
        }
        const { stack } = await blockchain.provider(wallet).get(method, [])
        return stack.readBigNumber()
    }

    return {
        blockchain,
        deployResult,
        deployer,
        treasury,
        stranger,
        owner,
        burner,
        dedust,
        burnerHgramWallet,
        burnerHpoWallet,
        hpoSupply,
        hgramSupply,
        hgramBalance: (owner) => balanceOf(HIPO_PARENT, owner, 'get_wallet_data'),
        hpoBalance: (owner) => balanceOf(HPO_MASTER, owner, 'get_wallet_data'),
    }
}

/**
 * Put a burner back into its pre-discovery state, so the "wallets not known yet" branch can be
 * exercised. Deployment normally completes discovery on its own, which leaves no other way in.
 */
export async function forgetWallets(f: Fixture): Promise<void> {
    const account = await f.blockchain.getContract(f.burner.address)
    const state = account.account.account?.storage.state
    if (state?.type !== 'active' || !state.state.code) {
        throw new Error('burner is not active')
    }
    await f.blockchain.setShardAccount(
        f.burner.address,
        createShardAccount({
            address: f.burner.address,
            code: state.state.code,
            data: burnerConfigToCell(emptyBurnerConfig((await f.burner.getOwnership()).owner)),
            balance: account.balance,
            workchain: 0,
        }),
    )
}
