import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress } from '@ton/core'

export const mockMode = {
    fill: 0,
    refund: 1,
    silent: 2,
} as const

export interface MockDedustConfig {
    ownHgramWallet: Address
    ownHpoWallet: Address
    /** HPO paid per 1 hGRAM in, scaled by 1e9. */
    rate: bigint
    mode: number
}

export function mockDedustConfigToCell(config: MockDedustConfig): Cell {
    return beginCell()
        .storeAddress(config.ownHgramWallet)
        .storeAddress(config.ownHpoWallet)
        .storeRef(beginCell().storeUint(config.rate, 64).storeUint(config.mode, 2).storeCoins(0).storeUint(0, 32).endCell())
        .endCell()
}

export class MockDedust implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new MockDedust(address)
    }

    static createFromConfig(config: MockDedustConfig, code: Cell, workchain = 0) {
        const data = mockDedustConfigToCell(config)
        const init = { code, data }
        return new MockDedust(contractAddress(workchain, init), init)
    }

    async getMockData(provider: ContractProvider) {
        const { stack } = await provider.get('get_mock_data', [])
        return {
            ownHgramWallet: stack.readAddress(),
            ownHpoWallet: stack.readAddress(),
            rate: stack.readBigNumber(),
            mode: stack.readNumber(),
            lastLimit: stack.readBigNumber(),
            swapsServed: stack.readNumber(),
        }
    }
}
