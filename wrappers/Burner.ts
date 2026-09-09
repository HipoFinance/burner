import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    Sender,
    SendMode,
    contractAddress,
} from '@ton/core'

import { UpgradeOptions, upgradeCodeBody } from './rescue'

/** op::take_borrower_fee, as sent by the Hipo treasury on every loan recovery. */
export const opTakeBorrowerFee = 0x5e2d81f4

export const opWithdraw = 0x7a9b3e51
export const opResetPending = 0x1c4f8a23
export const opTransferOwnership = 0x2f0b7d64
export const opClaimOwnership = 0x6d1e4c09
export const opDropOwnership = 0x4b8a2f17

export const errAccessDenied = 200

export const logTopic = {
    received: 1n,
    deposit: 2n,
    swap: 3n,
    burn: 4n,
    discovery: 5n,
} as const

/**
 * Sizing constants, mirrored from contracts/imports/constants.fc. Tests assert against these, so
 * a change in the contract that is not mirrored here fails loudly rather than silently.
 */
const swapGas = 400000000n
const burnGas = 100000000n
/** swap_gas + burn_gas: a cycle carries the gas for the rest of itself. */
const depositForward = swapGas + burnGas

export const budget = {
    reserve: 1000000000n,
    swapGas,
    swapForward: 300000000n,
    burnGas,
    discoveryGas: 50000000n,
    depositForward,
    /** 2 * deposit_forward: never deposit unless at least half of it is real stake. */
    minDeposit: 2n * depositForward,
} as const

export interface BurnerConfig {
    hgramWallet: Address | null
    hpoWallet: Address | null
    /** The rescue hatch. null means ownership was dropped and the contract is immutable. */
    owner: Address | null
    pendingOwner: Address | null
    totalReceived: bigint
    totalDeposited: bigint
    totalSwapped: bigint
    totalBurned: bigint
    hgramPending: bigint
    hpoPending: bigint
    depositCount: number
    swapCount: number
    burnCount: number
    queryId: bigint
}

export function burnerConfigToCell(config: BurnerConfig): Cell {
    return beginCell()
        .storeAddress(config.hgramWallet)
        .storeAddress(config.hpoWallet)
        .storeRef(beginCell().storeAddress(config.owner).storeAddress(config.pendingOwner).endCell())
        .storeRef(
            beginCell()
                .storeCoins(config.totalReceived)
                .storeCoins(config.totalDeposited)
                .storeCoins(config.totalSwapped)
                .storeCoins(config.totalBurned)
                .storeCoins(config.hgramPending)
                .storeCoins(config.hpoPending)
                .storeUint(config.depositCount, 32)
                .storeUint(config.swapCount, 32)
                .storeUint(config.burnCount, 32)
                .storeUint(config.queryId, 64)
                .endCell(),
        )
        .endCell()
}

/** The storage a freshly deployed burner starts from: nothing known, nothing done. */
export function emptyBurnerConfig(owner: Address | null = null): BurnerConfig {
    return {
        hgramWallet: null,
        hpoWallet: null,
        owner,
        pendingOwner: null,
        totalReceived: 0n,
        totalDeposited: 0n,
        totalSwapped: 0n,
        totalBurned: 0n,
        hgramPending: 0n,
        hpoPending: 0n,
        depositCount: 0,
        swapCount: 0,
        burnCount: 0,
        queryId: 0n,
    }
}

export interface BurnerData {
    hgramWallet: Address | null
    hpoWallet: Address | null
    totalReceived: bigint
    totalDeposited: bigint
    totalSwapped: bigint
    totalBurned: bigint
}

export interface BurnerProgress {
    hgramPending: bigint
    hpoPending: bigint
    depositCount: number
    swapCount: number
    burnCount: number
    queryId: bigint
}

export interface BurnerOwnership {
    owner: Address | null
    pendingOwner: Address | null
}

export interface BurnerRoute {
    treasury: Address
    parent: Address
    dedustHgramVault: Address
    dedustPool: Address
}

export class Burner implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Burner(address)
    }

    static createFromConfig(config: BurnerConfig, code: Cell, workchain = 0) {
        const data = burnerConfigToCell(config)
        const init = { code, data }
        return new Burner(contractAddress(workchain, init), init)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        })
    }

    /**
     * Pay the burner. Any GRAM works and any op works; this uses the treasury's own op so the
     * path under test is the one that runs in production.
     */
    async sendBorrowerFee(provider: ContractProvider, via: Sender, value: bigint, queryId = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(opTakeBorrowerFee, 32).storeUint(queryId, 64).endCell(),
        })
    }

    /** A bare transfer with no body, which must run the cycle just the same. */
    async sendGram(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        })
    }

    /** A poke: anyone can advance a stuck leg without the treasury paying anything. */
    async sendPoke(provider: ContractProvider, via: Sender, value = 50000000n) {
        await this.sendGram(provider, via, value)
    }

    async getBurnerData(provider: ContractProvider): Promise<BurnerData> {
        const { stack } = await provider.get('get_burner_data', [])
        const hgramWallet = stack.readCell().beginParse().loadMaybeAddress()
        const hpoWallet = stack.readCell().beginParse().loadMaybeAddress()
        return {
            hgramWallet,
            hpoWallet,
            totalReceived: stack.readBigNumber(),
            totalDeposited: stack.readBigNumber(),
            totalSwapped: stack.readBigNumber(),
            totalBurned: stack.readBigNumber(),
        }
    }

    /**
     * Send an arbitrary message on the contract's behalf. This is the whole rescue hatch: GRAM,
     * hGRAM, HPO and anything not yet invented all come out through it.
     */
    async sendWithdraw(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; mode: number; message: Cell; queryId?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(opWithdraw, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeUint(opts.mode, 8)
                .storeRef(opts.message)
                .endCell(),
        })
    }

    /** Square the pending amounts with reality after a withdrawal. */
    async sendResetPending(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; hgramPending: bigint; hpoPending: bigint; queryId?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(opResetPending, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeCoins(opts.hgramPending)
                .storeCoins(opts.hpoPending)
                .endCell(),
        })
    }

    async sendTransferOwnership(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; newOwner: Address; queryId?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(opTransferOwnership, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeAddress(opts.newOwner)
                .endCell(),
        })
    }

    async sendClaimOwnership(provider: ContractProvider, via: Sender, value: bigint, queryId = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(opClaimOwnership, 32).storeUint(queryId, 64).endCell(),
        })
    }

    /** One way. After this nobody can reach into the contract, ever. */
    async sendDropOwnership(provider: ContractProvider, via: Sender, value: bigint, queryId = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(opDropOwnership, 32).storeUint(queryId, 64).endCell(),
        })
    }

    /**
     * Install new code, optionally running a storage migration on the way.
     *
     * The body comes from wrappers/rescue.ts, so the tests exercise the same builder the upgrade
     * script sends. Owner only, and `drop_ownership` closes this along with the rescue hatch.
     */
    async sendUpgradeCode(
        provider: ContractProvider,
        via: Sender,
        opts: UpgradeOptions & { value: bigint; queryId?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: upgradeCodeBody(opts, opts.queryId ?? 0n),
        })
    }

    async getOwnership(provider: ContractProvider): Promise<BurnerOwnership> {
        const { stack } = await provider.get('get_ownership', [])
        return {
            owner: stack.readCell().beginParse().loadMaybeAddress(),
            pendingOwner: stack.readCell().beginParse().loadMaybeAddress(),
        }
    }

    async getProgress(provider: ContractProvider): Promise<BurnerProgress> {
        const { stack } = await provider.get('get_progress', [])
        return {
            hgramPending: stack.readBigNumber(),
            hpoPending: stack.readBigNumber(),
            depositCount: stack.readNumber(),
            swapCount: stack.readNumber(),
            burnCount: stack.readNumber(),
            queryId: stack.readBigNumber(),
        }
    }

    async getDepositable(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_depositable', [])
        return stack.readBigNumber()
    }

    async getRoute(provider: ContractProvider): Promise<BurnerRoute> {
        const { stack } = await provider.get('get_route', [])
        return {
            treasury: stack.readAddress(),
            parent: stack.readAddress(),
            dedustHgramVault: stack.readAddress(),
            dedustPool: stack.readAddress(),
        }
    }
}
