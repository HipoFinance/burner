import { Address, beginCell, Cell, Contract, contractAddress } from '@ton/core'

export interface MockHipoTreasuryConfig {
    parent: Address
    /** hGRAM minted per 1 GRAM staked, scaled by 1e9. The live rate is total_tokens/total_coins. */
    rate: bigint
    /** What the treasury keeps for gas, mirroring deposit_coins_fee. */
    fee: bigint
    /** When true the deposit throws, standing in for a halted treasury. */
    reject: boolean
}

export function mockHipoTreasuryConfigToCell(config: MockHipoTreasuryConfig): Cell {
    return beginCell()
        .storeAddress(config.parent)
        .storeUint(config.rate, 64)
        .storeCoins(config.fee)
        .storeUint(config.reject ? 1 : 0, 1)
        .endCell()
}

export class MockHipoTreasury implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new MockHipoTreasury(address)
    }

    static createFromConfig(config: MockHipoTreasuryConfig, code: Cell, workchain = 0) {
        const data = mockHipoTreasuryConfigToCell(config)
        const init = { code, data }
        return new MockHipoTreasury(contractAddress(workchain, init), init)
    }
}
