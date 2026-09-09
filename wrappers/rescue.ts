import { Address, beginCell, Cell } from '@ton/core'

/**
 * Message builders for the burner's rescue hatch.
 *
 * `op::withdraw` hands its payload straight to send_raw_message, so these build complete internal
 * messages rather than message bodies. Getting that cell layout wrong is the likeliest way to
 * lose funds during a recovery, which is why it lives here and not inside a script: the test
 * suite drives these same functions, so the code an operator runs in an emergency is the code
 * that is already proven.
 */

/** Hipo's send_tokens and TEP-74's transfer share op 0x0f8a7ea5 and the same body layout. */
export const opJettonTransfer = 0x0f8a7ea5

export interface InternalMessageOptions {
    to: Address
    /** Attached GRAM. Ignored by the receiver's accounting when mode carries the balance instead. */
    value: bigint
    body?: Cell
    /**
     * Bounceable. True for anything that must come back if it fails -- a jetton wallet op, say.
     * False for a plain payout, so it still arrives at an address that is not yet deployed.
     */
    bounce?: boolean
}

/**
 * A complete internal message, ready for send_raw_message.
 *
 *   int_msg_info$0 ihr_disabled:Bool bounce:Bool bounced:Bool src:MsgAddress dest:MsgAddressInt
 *     value:CurrencyCollection ihr_fee:Grams fwd_fee:Grams created_lt:uint64 created_at:uint32
 *   init:(Maybe (Either StateInit ^StateInit)) body:(Either X ^X)
 *
 * src is addr_none: the sending contract fills it in.
 */
export function internalMessage(opts: InternalMessageOptions): Cell {
    const bounce = opts.bounce ?? true
    const builder = beginCell()
        .storeUint(bounce ? 0x18 : 0x10, 6)
        .storeAddress(opts.to)
        .storeCoins(opts.value)
        .storeUint(0, 1 + 4 + 4 + 64 + 32)
        .storeUint(0, 1) // no state init

    if (opts.body === undefined) {
        return builder.storeUint(0, 1).endCell()
    }
    return builder.storeUint(1, 1).storeRef(opts.body).endCell()
}

/** A plain GRAM payout. Non-bounceable by default so it lands even on an uninitialised wallet. */
export function gramTransfer(to: Address, value: bigint, bounce = false): Cell {
    return internalMessage({ to, value, bounce })
}

export interface JettonTransferOptions {
    /** Where the tokens go -- an owner address, not a jetton wallet. */
    to: Address
    amount: bigint
    /** Who gets the leftover gas. Usually the same as `to`. */
    responseTo: Address
    forwardTonAmount?: bigint
    forwardPayload?: Cell
}

/**
 * transfer#0f8a7ea5 query_id:uint64 amount:Coins destination:MsgAddress
 *   response_destination:MsgAddress custom_payload:(Maybe ^Cell) forward_ton_amount:Coins
 *   forward_payload:(Either Cell ^Cell)
 *
 * Works for HPO, for any TEP-74 jetton, and for hGRAM: Hipo's send_tokens shares this op code and
 * this layout.
 */
export function jettonTransferBody(opts: JettonTransferOptions, queryId = 0n): Cell {
    const builder = beginCell()
        .storeUint(opJettonTransfer, 32)
        .storeUint(queryId, 64)
        .storeCoins(opts.amount)
        .storeAddress(opts.to)
        .storeAddress(opts.responseTo)
        .storeUint(0, 1) // no custom payload
        .storeCoins(opts.forwardTonAmount ?? 0n)

    if (opts.forwardPayload === undefined) {
        return builder.storeUint(0, 1).endCell()
    }
    return builder.storeUint(1, 1).storeRef(opts.forwardPayload).endCell()
}

/**
 * The whole message that moves jettons out of the burner: an internal message to the burner's own
 * jetton wallet carrying a transfer.
 *
 * `attached` pays the wallet's own fees and is returned to `responseTo`. Bounceable, so a refused
 * transfer comes back rather than being lost.
 */
export function jettonTransfer(
    burnerJettonWallet: Address,
    opts: JettonTransferOptions & { attached: bigint },
    queryId = 0n,
): Cell {
    return internalMessage({
        to: burnerJettonWallet,
        value: opts.attached,
        body: jettonTransferBody(opts, queryId),
        bounce: true,
    })
}

/** Same op code and layout as the treasury's, so one upgrade procedure covers both contracts. */
export const opUpgradeCode = 0x3d6a29b5

export interface UpgradeOptions {
    newCode: Cell
    /**
     * A one-off storage migration, blessed and run once inside the upgrade transaction.
     *
     * Absent is the only way to say "no migration" -- an empty cell is not a second way, and would
     * be run and throw. Leave it undefined for an upgrade that does not change the layout.
     */
    migrateCode?: Cell
    /** Where the leftover gas goes. */
    returnExcess: Address
}

/**
 * upgrade_code#3d6a29b5 query_id:uint64 new_code:^Cell migrate_code:(Maybe ^Cell)
 *   return_excess:MsgAddr
 *
 * This is a body, not a complete message: unlike the rescue-hatch builders above it is sent to the
 * burner rather than handed to send_raw_message.
 */
export function upgradeCodeBody(opts: UpgradeOptions, queryId = 0n): Cell {
    const builder = beginCell()
        .storeUint(opUpgradeCode, 32)
        .storeUint(queryId, 64)
        .storeRef(opts.newCode)

    if (opts.migrateCode === undefined) {
        builder.storeUint(0, 1)
    } else {
        builder.storeUint(1, 1).storeRef(opts.migrateCode)
    }
    return builder.storeAddress(opts.returnExcess).endCell()
}
